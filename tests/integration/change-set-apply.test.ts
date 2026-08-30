import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveRoomRegistry } from "../../src/active-rooms.js";
import type { ChangeSetApplyPlan, ChangeSetApplyPreflightResult } from "../../src/change-set-apply.js";
import {
  ChangeSetIntegrationService,
  type ChangeSetApplication,
  type ChangeSetIntegrationServiceOptions,
  type ChangeSetIntegrationWorkspace,
} from "../../src/change-set-integration.js";
import { IntegrationJournalStore } from "../../src/integration-journal.js";
import { EventLedger } from "../../src/events.js";
import { CollabGateway } from "../../src/gateway.js";
import { InviteStore } from "../../src/invites.js";
import { CHANGE_SET_CAPABILITY, COLLAB_CAPABILITY_HEADER } from "../../src/protocol.js";
import { RoomStore } from "../../src/room.js";
import type { ChangeSetStagingService } from "../../src/change-set-staging.js";
import type { WorkspaceVersionRecord } from "../../src/workspace-versions.js";
import { WorkspaceService } from "../../src/workspace-service.js";
import { WorkspaceSharingRegistry } from "../../src/workspace-sharing.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const oldBytes = Buffer.from("old\n");
const newBytes = Buffer.from("new\n");
const addBytes = Buffer.from("added\n");
const changeSetId = "a".repeat(64);

function plan(): ChangeSetApplyPlan {
  return {
    roomId: "room-1",
    changeSetId,
    baseWorkspaceVersionId: "version-1",
    operations: [{
      path: "src/value.ts",
      operation: "modify",
      base: { path: "src/value.ts", contentHash: hash(oldBytes), size: oldBytes.byteLength },
      result: { contentHash: hash(newBytes), size: newBytes.byteLength, bytes: new Uint8Array(newBytes) },
    }, {
      path: "src/added.ts",
      operation: "add",
      result: { contentHash: hash(addBytes), size: addBytes.byteLength, bytes: new Uint8Array(addBytes) },
    }],
  };
}

class MemoryWorkspace implements ChangeSetIntegrationWorkspace {
  readonly files = new Map<string, Uint8Array>([["src/value.ts", oldBytes]]);
  mutations = 0;
  failAtMutation?: number;

  async inspect(_roomId: string, path: string) {
    const bytes = this.files.get(path);
    return bytes ? { contentHash: hash(bytes), size: bytes.byteLength } : undefined;
  }

  forRoom(_roomId: string) {
    return {
      read: async (path: string) => this.files.get(path) ? structuredClone(this.files.get(path)) : undefined,
      replace: async (path: string, bytes: Uint8Array) => {
        this.files.set(path, structuredClone(bytes));
        this.afterMutation();
      },
      remove: async (path: string) => {
        this.files.delete(path);
        this.afterMutation();
      },
    };
  }

  private afterMutation(): void {
    this.mutations += 1;
    if (this.failAtMutation === this.mutations) throw new Error("write failed");
  }
}

function version(id = "b".repeat(64)): WorkspaceVersionRecord {
  return {
    version: {
      workspaceVersionId: id,
      roomId: "room-1",
      parentVersionId: "version-1",
      files: [],
      createdBy: "member-host",
      createdAt: 50,
    },
    manifestHash: hash("[]"),
    artifact: { kind: "workspace-snapshot.v1", snapshotId: id, manifestHash: hash("[]"), totalBytes: 0 },
  };
}

async function setup(input: {
  preflight?: ChangeSetApplyPreflightResult;
  commit?: () => Promise<void>;
  persist?: boolean;
  workspace?: MemoryWorkspace;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-apply-"));
  roots.push(root);
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "principal-host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", now: 1 });
  const workspace = input.workspace ?? new MemoryWorkspace();
  const applications = new Map<string, ChangeSetApplication>();
  const records = new Map<string, WorkspaceVersionRecord>([["version-1", version("version-1")]]);
  const published = version();
  const preflight = vi.fn(async (): Promise<ChangeSetApplyPreflightResult> => structuredClone(
    input.preflight ?? { outcome: "ready" as const, plan: plan() },
  ));
  const capture = vi.fn(async () => ({ snapshotId: published.version.workspaceVersionId }));
  const create = vi.fn(async (_input: unknown, hooks?: { beforePublish(record: WorkspaceVersionRecord): void | (() => void) }) => {
    hooks?.beforePublish(published);
    records.set(published.version.workspaceVersionId, structuredClone(published));
    return { record: structuredClone(published), created: true };
  });
  let now = 100;
  const reviews = {
    getApplication: (roomId: string, id: string) => applications.get(`${roomId}\0${id}`),
    prepareApplication: vi.fn(async ({ roomId, principalId, changeSetId: id }: { roomId: string; principalId: string; changeSetId: string }) => {
      const member = rooms.authorize(roomId, principalId, "read");
      if (member.role !== "host") throw new Error("not owner");
      return {
        existing: applications.get(`${roomId}\0${id}`),
        commit: (workspaceVersionId: string, integrationId: string) => {
          const application: ChangeSetApplication = {
            version: 1,
            applicationId: hash(`${roomId}\0${id}\0application`),
            roomId,
            changeSetId: id,
            appliedBy: member.memberId,
            workspaceVersionId,
            integrationId,
            createdAt: now++,
          };
          applications.set(`${roomId}\0${id}`, application);
          return structuredClone(application);
        },
      };
    }),
  };
  const commit = vi.fn(input.commit ?? (async () => {}));
  const serviceOptions: ChangeSetIntegrationServiceOptions = {
    rooms,
    preflight: { preflight },
    journals: new IntegrationJournalStore(root),
    workspace,
    reviews,
    versions: {
      latest: () => records.get([...records.keys()].at(-1)!)!,
      get: (_roomId, id) => records.get(id),
      create,
    },
    snapshots: { capture },
    commitCriticalState: commit,
  };
  if (input.persist === false) delete (serviceOptions as { commitCriticalState?: () => Promise<void> }).commitCriticalState;
  const service = new ChangeSetIntegrationService(serviceOptions);
  return { applications, capture, commit, create, journals: new IntegrationJournalStore(root), preflight, published, records, rooms, service, workspace };
}

describe("ChangeSet apply integration", () => {
  it("refuses to run without a durable whole-runtime persistence barrier", async () => {
    await expect(setup({ persist: false })).rejects.toThrow(/persistence/i);
  });

  it("applies each operation once, checkpoints it, records applied, and publishes the next Workspace Version", async () => {
    const state = await setup();

    const result = await state.service.apply({ roomId: "room-1", principalId: "principal-host", changeSetId, clientRequestId: "apply-1" });

    expect(result).toMatchObject({ outcome: "applied", application: { changeSetId, workspaceVersionId: state.published.version.workspaceVersionId } });
    expect(state.workspace.files.get("src/value.ts")).toEqual(new Uint8Array(newBytes));
    expect(state.workspace.files.get("src/added.ts")).toEqual(new Uint8Array(addBytes));
    expect(state.workspace.mutations).toBe(2);
    expect(state.capture).toHaveBeenCalledWith(expect.objectContaining({ parentVersionId: "version-1", changeSetId }));
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ parentVersionId: "version-1" }), expect.objectContaining({ beforePublish: expect.any(Function) }));
    expect(state.commit).toHaveBeenCalledOnce();
    expect(await state.journals.list()).toEqual([]);

    const retry = await state.service.apply({ roomId: "room-1", principalId: "principal-host", changeSetId, clientRequestId: "apply-retry" });
    expect(retry).toEqual(result);
    expect(state.workspace.mutations).toBe(2);
    expect(state.capture).toHaveBeenCalledOnce();
    expect(state.create).toHaveBeenCalledOnce();
  });

  it("persists a preflight conflict without creating a journal or touching the workspace", async () => {
    const conflict = {
      version: 1 as const,
      conflictId: "c".repeat(64),
      roomId: "room-1",
      changeSetId,
      baseWorkspaceVersionId: "version-1",
      detectedBy: "member-host",
      conflicts: [{ path: "src/value.ts", kind: "base-changed" as const }],
      createdAt: 20,
    };
    const state = await setup({ preflight: { outcome: "conflicted", conflict } });

    await expect(state.service.apply({ roomId: "room-1", principalId: "principal-host", changeSetId, clientRequestId: "conflict" }))
      .resolves.toEqual({ outcome: "conflicted", conflict });
    expect(state.commit).toHaveBeenCalledOnce();
    expect(state.workspace.mutations).toBe(0);
    expect(await state.journals.list()).toEqual([]);
  });

  it("rolls back every file and leaves no published state when a workspace step fails", async () => {
    const workspace = new MemoryWorkspace();
    workspace.failAtMutation = 2;
    const state = await setup({ workspace });

    await expect(state.service.apply({ roomId: "room-1", principalId: "principal-host", changeSetId, clientRequestId: "failing" }))
      .rejects.toThrow("write failed");
    expect([...workspace.files.get("src/value.ts")!]).toEqual([...oldBytes]);
    expect(workspace.files.has("src/added.ts")).toBe(false);
    expect(state.capture).not.toHaveBeenCalled();
    expect(state.applications.size).toBe(0);
    expect(await state.journals.list()).toEqual([]);
  });

  it("keeps a completed journal when the runtime persistence barrier fails, then retries without rewriting files", async () => {
    let attempts = 0;
    const state = await setup({ commit: async () => { if (++attempts === 1) throw new Error("state save failed"); } });

    await expect(state.service.apply({ roomId: "room-1", principalId: "principal-host", changeSetId, clientRequestId: "apply" }))
      .rejects.toThrow("state save failed");
    expect(state.workspace.mutations).toBe(2);
    expect(await state.journals.list()).toHaveLength(1);

    await expect(state.service.apply({ roomId: "room-1", principalId: "principal-host", changeSetId, clientRequestId: "retry" }))
      .resolves.toMatchObject({ outcome: "applied" });
    expect(state.workspace.mutations).toBe(2);
    expect(state.commit).toHaveBeenCalledTimes(2);
    expect(await state.journals.list()).toEqual([]);
  });

  it("rejects a second concurrent integration in the same room", async () => {
    let release!: () => void;
    const state = await setup();
    state.capture.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { snapshotId: state.published.version.workspaceVersionId };
    });
    const first = state.service.apply({ roomId: "room-1", principalId: "principal-host", changeSetId, clientRequestId: "first" });
    await vi.waitFor(() => expect(state.capture).toHaveBeenCalledOnce());

    await expect(state.service.apply({ roomId: "room-1", principalId: "principal-host", changeSetId: "d".repeat(64), clientRequestId: "second" }))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    release();
    await first;
  });

  it("shares its room lock with manual Workspace Version publication", async () => {
    let release!: () => void;
    const state = await setup();
    state.capture.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { snapshotId: state.published.version.workspaceVersionId };
    });
    const applying = state.service.apply({ roomId: "room-1", principalId: "principal-host", changeSetId, clientRequestId: "apply" });
    await vi.waitFor(() => expect(state.capture).toHaveBeenCalledOnce());

    await expect(state.service.runWithRoomIntegrationLock("room-1", async () => "published"))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    release();
    await applying;
  });

  it("reconciles pending journals by retiring durable applications and rolling back uncommitted writes", async () => {
    const committed = await setup();
    const committedJournal = await committed.journals.prepare(plan(), committed.workspace.forRoom("room-1"));
    for (let step = 1; step <= committedJournal.executorStepCount; step += 1) await committed.journals.markExecutorCheckpoint(committedJournal.integrationId, step);
    committed.applications.set(`room-1\0${changeSetId}`, {
      version: 1,
      applicationId: hash(`room-1\0${changeSetId}\0application`),
      roomId: "room-1",
      changeSetId,
      appliedBy: "member-host",
      workspaceVersionId: committed.published.version.workspaceVersionId,
      integrationId: committedJournal.integrationId,
      createdAt: 100,
    });
    committed.records.set(committed.published.version.workspaceVersionId, committed.published);
    await committed.service.recoverPending();
    expect(await committed.journals.list()).toEqual([]);
    expect(committed.workspace.mutations).toBe(0);

    const interrupted = await setup();
    const interruptedJournal = await interrupted.journals.prepare(plan(), interrupted.workspace.forRoom("room-1"));
    await interrupted.workspace.forRoom("room-1").replace("src/value.ts", newBytes);
    await interrupted.journals.markExecutorCheckpoint(interruptedJournal.integrationId, 1);
    await interrupted.service.recoverPending();
    expect([...interrupted.workspace.files.get("src/value.ts")!]).toEqual([...oldBytes]);
    expect(await interrupted.journals.list()).toEqual([]);
  });

  it("exposes apply only through the authenticated change-set capability route", async () => {
    const state = await setup();
    const ledger = new EventLedger();
    const activeRooms = new ActiveRoomRegistry();
    activeRooms.activate("room-1");
    const sharing = new WorkspaceSharingRegistry();
    sharing.set("room-1", true, "member-host", 2);
    const gateway = new CollabGateway({
      rooms: state.rooms,
      ledger,
      invites: new InviteStore(state.rooms),
      agent: { followup() {}, steer() {}, cancel() {} },
      tokenTtlMs: null,
      tokenFactory: () => "host-token",
      activeRooms,
      workspace: new WorkspaceService({ rooms: state.rooms, registry: sharing }),
      changeSets: { get: async () => undefined } as unknown as ChangeSetStagingService,
      changeSetIntegration: state.service,
    });
    const bootstrap = await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "principal-host" } });
    const token = (bootstrap.body as { roomToken: string }).roomToken;

    await expect(gateway.handle({
      method: "POST",
      path: `/v1/rooms/room-1/change-sets/${changeSetId}/apply`,
      headers: { authorization: `Bearer ${token}` },
      body: { clientRequestId: "apply-no-capability" },
    })).resolves.toMatchObject({ status: 404 });
    await expect(gateway.handle({
      method: "POST",
      path: `/v1/rooms/room-1/change-sets/${changeSetId}/apply`,
      headers: { authorization: `Bearer ${token}`, [COLLAB_CAPABILITY_HEADER]: CHANGE_SET_CAPABILITY },
      body: { clientRequestId: "apply-route" },
    })).resolves.toMatchObject({ status: 200, body: { outcome: "applied" } });
  });
});
