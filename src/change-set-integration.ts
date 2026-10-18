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
import type { CollaborationTask } from "./collaboration-types.js";
import type { ChangeSetReview } from "./change-set-reviews.js";
import type { TaskStore } from "./tasks.js";
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
  getReview?(input: { roomId: string; principalId: string; changeSetId: string }): Promise<ChangeSetReview>;
  prepareApplication(input: { roomId: string; principalId: string; changeSetId: string; allowDirectOwnerMerge?: boolean }): Promise<PreparedChangeSetApplication>;
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
  tasks?: TaskStore;
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
    taskId?: string;
    direct?: boolean;
    clientRequestId: string;
  }): Promise<ChangeSetIntegrationResult> {
    requiredRequestId(input.clientRequestId);
    const actor = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (actor.role !== "host") throw new CollabError("ACTION_FORBIDDEN", "only the Owner can apply a ChangeSet");
    return await this.runWithRoomIntegrationLock(input.roomId, async () => {
      const existing = this.options.reviews.getApplication(input.roomId, input.changeSetId);
      const task = await this.resolveMergeTask(input, Boolean(existing));
      if (existing) return await this.finishDurableApplication(existing, input.principalId, task);

      const prepared = await this.options.reviews.prepareApplication({
        roomId: input.roomId,
        principalId: input.principalId,
        changeSetId: input.changeSetId,
        ...(input.direct ? { allowDirectOwnerMerge: true } : {}),
      });
      if (prepared.existing) return await this.finishDurableApplication(prepared.existing, input.principalId, task);
      const preflight = await this.options.preflight.preflight(input);
      if (preflight.outcome === "conflicted") {
        await this.options.commitCriticalState();
        return { outcome: "conflicted", conflict: structuredClone(preflight.conflict) };
      }
      return await this.execute(input, preflight.plan, prepared, task);
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
    input: { roomId: string; principalId: string; changeSetId: string; direct?: boolean },
    plan: ChangeSetApplyPlan,
    prepared: PreparedChangeSetApplication,
    task?: CollaborationTask,
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
      if (task) this.completeTask(task, input.principalId, application, input.direct === true);
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

  private async finishDurableApplication(application: ChangeSetApplication, principalId: string, task?: CollaborationTask): Promise<ChangeSetIntegrationResult> {
    const record = this.options.versions.get(application.roomId, application.workspaceVersionId);
    if (!record) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet application Workspace Version does not exist");
    this.appendApplicationEvent(application, principalId);
    if (task) this.completeTask(task, principalId, application, false);
    await this.options.commitCriticalState();
    if (await this.options.journals.load(application.integrationId)) {
      await this.options.journals.complete(application.integrationId);
    }
    return { outcome: "applied", application: structuredClone(application), workspaceVersion: structuredClone(record) };
  }

  private async resolveMergeTask(
    input: { roomId: string; principalId: string; changeSetId: string; taskId?: string; direct?: boolean },
    allowCompletedApplicationRetry = false,
  ): Promise<CollaborationTask | undefined> {
    if (!this.options.tasks) return undefined;
    const candidates = input.taskId
      ? (() => {
        const task = this.options.tasks!.get(input.taskId, false);
        return task ? [task] : [];
      })()
      : this.options.tasks.findByChangeSet(input.roomId, input.changeSetId);
    if (candidates.length > 1) throw new CollabError("REQUEST_STATE", "ChangeSet is linked to multiple Tasks; taskId is required");
    const task = candidates[0];
    if (!task) {
      if (input.taskId) throw new CollabError("REQUEST_NOT_FOUND", "Task was not found", { taskId: input.taskId });
      return undefined;
    }
    if (task.roomId !== input.roomId || !task.changeSetIds.includes(input.changeSetId)) throw new CollabError("ACTION_FORBIDDEN", "Task is not linked to this ChangeSet");
    if (task.status === "cancelled") throw new CollabError("REQUEST_STATE", "Cancelled Task cannot be merged");
    if (!input.direct && task.status !== "in-review" && !(allowCompletedApplicationRetry && task.status === "done")) {
      throw new CollabError("REQUEST_STATE", "Code Task must be in-review before it can be merged");
    }
    if (!input.direct && task.status !== "done") {
      if (!this.options.reviews.getReview) throw new CollabError("REQUEST_STATE", "ChangeSet review capability is unavailable");
      const review = await this.options.reviews.getReview({ roomId: input.roomId, principalId: input.principalId, changeSetId: input.changeSetId });
      if (review.status !== "approved" || review.requiredReviewerId !== task.assigneeId) {
        throw new CollabError("REQUEST_STATE", "Task responsibility review must be approved before merge");
      }
    }
    return task;
  }

  private completeTask(task: CollaborationTask, principalId: string, application: ChangeSetApplication, direct: boolean): void {
    if (!this.options.tasks || task.status === "done") return;
    const actor = { memberId: application.appliedBy, principalId };
    let current = this.options.tasks.get(task.taskId);
    if (direct && current.status === "open") {
      current = this.options.tasks.setStatus({ taskId: task.taskId, status: "doing", actor, eventId: `task-direct-doing:${application.applicationId}`, now: application.createdAt });
    }
    if (direct && current.status === "doing") {
      current = this.options.tasks.setStatus({ taskId: task.taskId, status: "in-review", actor, eventId: `task-direct-review:${application.applicationId}`, now: application.createdAt });
    }
    this.options.tasks.complete({
      taskId: task.taskId,
      actor,
      eventId: `task-completed:${application.applicationId}`,
      now: application.createdAt,
    });
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
