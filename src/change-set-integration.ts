import { createHash, randomUUID } from "node:crypto";
import type {
  ChangeSetApplyConflictRecord,
  ChangeSetApplyPlan,
  ChangeSetApplyPreflightResult,
  ChangeSetApplyWorkspaceReader,
} from "./change-set-apply.js";
import { CollabError, invalidInput } from "./errors.js";
import type { EventLedger } from "./events.js";
import type { IntegrationJournalStore, IntegrationJournalWorkspace } from "./integration-journal.js";
import type { RoomStore } from "./room.js";
import type { WorkspaceVersionRecord } from "./workspace-versions.js";

export interface ChangeSetApplication {
  version: 1;
  applicationId: string;
  roomId: string;
  changeSetId: string;
  appliedBy: string;
  workspaceVersionId: string;
  integrationId: string;
  createdAt: number;
}

export interface PreparedChangeSetApplication {
  existing?: ChangeSetApplication;
  commit(workspaceVersionId: string, integrationId: string): ChangeSetApplication;
  rollback?(applicationId: string): void;
}

export interface ChangeSetIntegrationReviewPort {
  getApplication(roomId: string, changeSetId: string): ChangeSetApplication | undefined;
  prepareApplication(input: { roomId: string; principalId: string; changeSetId: string }): Promise<PreparedChangeSetApplication>;
}

export interface ChangeSetIntegrationWorkspace extends ChangeSetApplyWorkspaceReader, IntegrationJournalWorkspace {}

export interface ChangeSetIntegrationVersionPort {
  latest(roomId: string): WorkspaceVersionRecord | undefined;
  get(roomId: string, workspaceVersionId: string): WorkspaceVersionRecord | undefined;
  create(input: {
    roomId: string;
    principalId: string;
    snapshotId: string;
    parentVersionId?: string;
  }, hooks?: { beforePublish(record: WorkspaceVersionRecord): void | (() => void) }): Promise<{ record: WorkspaceVersionRecord; created: boolean }>;
}

export interface ChangeSetIntegrationSnapshotPort {
  capture(input: {
    roomId: string;
    principalId: string;
    changeSetId: string;
    parentVersionId: string;
    clientRequestId: string;
  }): Promise<{ snapshotId: string }>;
}

export type ChangeSetIntegrationResult =
  | { outcome: "conflicted"; conflict: ChangeSetApplyConflictRecord }
  | { outcome: "applied"; application: ChangeSetApplication; workspaceVersion: WorkspaceVersionRecord };

export interface ChangeSetIntegrationServiceOptions {
  rooms: RoomStore;
  ledger: EventLedger;
  preflight: { preflight(input: { roomId: string; principalId: string; changeSetId: string }): Promise<ChangeSetApplyPreflightResult> };
  journals: IntegrationJournalStore;
  workspace: ChangeSetIntegrationWorkspace;
  reviews: ChangeSetIntegrationReviewPort;
  versions: ChangeSetIntegrationVersionPort;
  snapshots: ChangeSetIntegrationSnapshotPort;
  commitCriticalState: () => Promise<void>;
}

function requiredRequestId(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 128) {
    throw invalidInput("clientRequestId must contain between 1 and 128 characters", { field: "clientRequestId" });
  }
  return value.trim();
}

function applicationIdentity(roomId: string, changeSetId: string): string {
  return createHash("sha256").update(`${roomId}\0${changeSetId}\0application`).digest("hex");
}

export function createChangeSetApplication(input: {
  roomId: string;
  changeSetId: string;
  appliedBy: string;
  workspaceVersionId: string;
  integrationId: string;
  createdAt: number;
}): ChangeSetApplication {
  return {
    version: 1,
    applicationId: applicationIdentity(input.roomId, input.changeSetId),
    ...input,
  };
}

export class ChangeSetIntegrationService {
  private readonly activeRooms = new Set<string>();

  constructor(private readonly options: ChangeSetIntegrationServiceOptions) {
    if (typeof options.commitCriticalState !== "function") {
      throw new Error("ChangeSet integration requires a durable whole-runtime persistence barrier");
    }
  }

  async apply(input: {
    roomId: string;
    principalId: string;
    changeSetId: string;
    clientRequestId: string;
  }): Promise<ChangeSetIntegrationResult> {
    requiredRequestId(input.clientRequestId);
    const actor = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (actor.role !== "host") throw new CollabError("ACTION_FORBIDDEN", "only the Owner can apply a ChangeSet");
    return await this.runWithRoomIntegrationLock(input.roomId, async () => {
      const existing = this.options.reviews.getApplication(input.roomId, input.changeSetId);
      if (existing) return await this.finishDurableApplication(existing, input.principalId);

      const prepared = await this.options.reviews.prepareApplication(input);
      if (prepared.existing) return await this.finishDurableApplication(prepared.existing, input.principalId);
      const preflight = await this.options.preflight.preflight(input);
      if (preflight.outcome === "conflicted") {
        await this.options.commitCriticalState();
        return { outcome: "conflicted", conflict: structuredClone(preflight.conflict) };
      }
      return await this.execute(input, preflight.plan, prepared);
    });
  }

  async runWithRoomIntegrationLock<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeRooms.has(roomId)) throw new CollabError("REQUEST_CONFLICT", "another ChangeSet integration is active in this room");
    this.activeRooms.add(roomId);
    try {
      return await operation();
    } finally {
      this.activeRooms.delete(roomId);
    }
  }

  async recoverPending(): Promise<void> {
    for (const integrationId of await this.options.journals.list()) {
      const journal = await this.options.journals.load(integrationId);
      if (!journal) continue;
      const application = this.options.reviews.getApplication(journal.roomId, journal.changeSetId);
      if (application) {
        if (application.integrationId !== integrationId
          || !this.options.versions.get(journal.roomId, application.workspaceVersionId)) {
          throw new CollabError("SNAPSHOT_INVALID", "durable ChangeSet application does not match its integration journal");
        }
        await this.options.journals.complete(integrationId);
        continue;
      }
      await this.options.journals.recover(integrationId, this.options.workspace);
    }
  }

  private async execute(
    input: { roomId: string; principalId: string; changeSetId: string },
    plan: ChangeSetApplyPlan,
    prepared: PreparedChangeSetApplication,
  ): Promise<ChangeSetIntegrationResult> {
    const latest = this.options.versions.latest(input.roomId);
    if (!latest || latest.version.workspaceVersionId !== plan.baseWorkspaceVersionId) {
      throw new CollabError("REQUEST_CONFLICT", "ChangeSet base is no longer the latest Workspace Version");
    }
    const journal = await this.options.journals.prepare(plan);
    let runtimeMutated = false;
    try {
      await this.options.workspace.applyPatch(plan.roomId, plan.patch);
      const snapshot = await this.options.snapshots.capture({
        roomId: input.roomId,
        principalId: input.principalId,
        changeSetId: input.changeSetId,
        parentVersionId: plan.baseWorkspaceVersionId,
        clientRequestId: `changeset-apply-${randomUUID()}`,
      });
      if (!/^[a-f0-9]{64}$/.test(snapshot.snapshotId)) {
        throw new CollabError("SNAPSHOT_INVALID", "captured apply Workspace Version identity is invalid");
      }
      let application: ChangeSetApplication | undefined;
      const published = await this.options.versions.create({
        roomId: input.roomId,
        principalId: input.principalId,
        snapshotId: snapshot.snapshotId,
        parentVersionId: plan.baseWorkspaceVersionId,
      }, {
        beforePublish: (record) => {
          application = prepared.commit(record.version.workspaceVersionId, journal.integrationId);
          return () => prepared.rollback?.(application!.applicationId);
        },
      });
      runtimeMutated = true;
      if (!application) {
        application = prepared.commit(published.record.version.workspaceVersionId, journal.integrationId);
      }
      this.appendApplicationEvent(application, input.principalId);
      await this.options.commitCriticalState();
      await this.options.journals.complete(journal.integrationId);
      return { outcome: "applied", application: structuredClone(application), workspaceVersion: structuredClone(published.record) };
    } catch (error) {
      if (!runtimeMutated) {
        try {
          await this.options.journals.recover(journal.integrationId, this.options.workspace);
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "ChangeSet integration failed and rollback is incomplete");
        }
      }
      throw error;
    }
  }

  private async finishDurableApplication(application: ChangeSetApplication, principalId: string): Promise<ChangeSetIntegrationResult> {
    const record = this.options.versions.get(application.roomId, application.workspaceVersionId);
    if (!record) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet application Workspace Version does not exist");
    this.appendApplicationEvent(application, principalId);
    await this.options.commitCriticalState();
    if (await this.options.journals.load(application.integrationId)) {
      await this.options.journals.complete(application.integrationId);
    }
    return { outcome: "applied", application: structuredClone(application), workspaceVersion: structuredClone(record) };
  }

  private appendApplicationEvent(application: ChangeSetApplication, principalId: string): void {
    this.options.ledger.append({
      eventId: `changeset-applied:${application.applicationId}`,
      roomId: application.roomId,
      type: "changeset.applied",
      actor: { memberId: application.appliedBy, principalId },
      createdAt: application.createdAt,
      payload: application,
    });
  }
}
