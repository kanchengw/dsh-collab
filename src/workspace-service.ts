import { createHash } from "node:crypto";
import { CollabError } from "./errors.js";
import type { EventLedger } from "./events.js";
import { RoomStore } from "./room.js";
import type { ReviewPointDiff, WorkspaceSharingState, WorkspaceSnapshotPackage } from "./collaboration-types.js";
import { WorkspaceSharingRegistry } from "./workspace-sharing.js";
import { WorkspaceSnapshotError } from "./workspace-snapshot.js";

export interface WorkspaceSnapshotProvider {
  capture(input: { roomId: string; hostSessionId: string; roomEventSeq: number; snapshotId: string; signal?: AbortSignal }): Promise<WorkspaceSnapshotPackage>;
  load(snapshotId: string): Promise<WorkspaceSnapshotPackage | undefined>;
  readChunk(snapshotId: string, path: string, offset: number, length: number): Promise<Uint8Array>;
  readFile?(snapshotId: string, path: string): Promise<Uint8Array>;
  captureReviewDiffs?(input: { snapshot: WorkspaceSnapshotPackage; files: readonly { path: string; previousPath?: string; status: "added" | "modified" | "deleted" | "renamed" }[] }): Promise<ReviewPointDiff[]>;
}

export type WorkspaceSnapshotPurpose = "workspace-snapshot" | "workspace-version" | "review-point" | "review-refresh";

export class WorkspaceService {
  private readonly now: () => number;

  constructor(private readonly options: {
    rooms: RoomStore;
    ledger: EventLedger;
    registry: WorkspaceSharingRegistry;
    snapshots?: WorkspaceSnapshotProvider;
    now?: () => number;
  }) {
    this.now = options.now ?? (() => Date.now());
  }

  getState(input: { roomId: string; principalId: string }): WorkspaceSharingState {
    this.options.rooms.authorize(input.roomId, input.principalId, "read");
    return this.currentState(input.roomId);
  }

  setSharing(input: { roomId: string; principalId: string; enabled: boolean }): WorkspaceSharingState {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (member.role !== "host") {
      throw new CollabError("ACTION_FORBIDDEN", "only the Host can change Workspace Sharing");
    }
    const previous = this.options.registry.get(input.roomId);
    const createdAt = this.now();
    const state = this.options.registry.set(
      input.roomId,
      input.enabled,
      member.memberId,
      createdAt,
      this.options.ledger.latestSeq(input.roomId) + 1,
    );
    if (state.revision !== previous.revision) {
      this.options.ledger.append({
        eventId: `workspace-sharing:${input.roomId}:${String(state.revision)}`,
        roomId: input.roomId,
        type: "workspace-sharing.changed",
        actor: { memberId: member.memberId, principalId: input.principalId },
        createdAt,
        payload: state,
      });
    }
    return this.currentState(input.roomId);
  }

  requireWorkspaceRead(input: { roomId: string; principalId: string }): WorkspaceSharingState {
    const state = this.getState(input);
    if (!state.enabled) {
      throw new CollabError("WORKSPACE_SHARING_DISABLED", "Workspace Sharing is disabled", { roomId: input.roomId });
    }
    return state;
  }

  clearRoom(roomId: string): void {
    this.options.registry.clear(roomId);
  }

  get snapshotsAvailable(): boolean {
    return this.options.snapshots !== undefined;
  }

  async captureLatest(input: { roomId: string; principalId: string; clientRequestId: string; purpose: WorkspaceSnapshotPurpose; roomEventSeq: number; signal?: AbortSignal }): Promise<WorkspaceSnapshotPackage> {
    this.requireWorkspaceRead(input);
    const provider = this.requireSnapshots();
    const room = this.options.rooms.getRoom(input.roomId);
    const snapshotId = createHash("sha256").update(`${input.roomId}\0${input.principalId}\0${input.purpose}\0${input.clientRequestId}`).digest("hex");
    const existing = await provider.load(snapshotId);
    if (existing) return this.assertRoomSnapshot(existing, room.roomId, room.hostSessionId);
    try {
      const captured = await provider.capture({
        roomId: room.roomId,
        hostSessionId: room.hostSessionId,
        roomEventSeq: input.roomEventSeq,
        snapshotId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return this.assertRoomSnapshot(captured, room.roomId, room.hostSessionId);
    } catch (error) {
      const raced = await provider.load(snapshotId);
      if (raced) return this.assertRoomSnapshot(raced, room.roomId, room.hostSessionId);
      if (error instanceof WorkspaceSnapshotError) {
        if (error.code === "WORKSPACE_LIMIT") throw new CollabError("RESOURCE_LIMIT", error.message);
        throw new CollabError("SNAPSHOT_INVALID", "Unable to capture Workspace Snapshot");
      }
      throw error;
    }
  }

  async getSnapshot(input: { roomId: string; principalId: string; snapshotId: string }): Promise<WorkspaceSnapshotPackage> {
    this.requireWorkspaceRead(input);
    const room = this.options.rooms.getRoom(input.roomId);
    const snapshot = await this.requireSnapshots().load(input.snapshotId);
    if (!snapshot) throw new CollabError("SNAPSHOT_NOT_FOUND", "Workspace Snapshot does not exist");
    return this.assertRoomSnapshot(snapshot, room.roomId);
  }

  async captureReviewDiffs(input: { roomId: string; principalId: string; snapshot: WorkspaceSnapshotPackage; files: readonly { path: string; previousPath?: string; status: "added" | "modified" | "deleted" | "renamed" }[] }): Promise<ReviewPointDiff[]> {
    this.requireWorkspaceRead(input);
    const provider = this.requireSnapshots();
    const snapshot = this.assertRoomSnapshot(input.snapshot, input.roomId, this.options.rooms.getRoom(input.roomId).hostSessionId);
    if (!provider.captureReviewDiffs) throw new CollabError("SNAPSHOT_NOT_FOUND", "Review Point diff capture is unavailable");
    try {
      return await provider.captureReviewDiffs({ snapshot, files: input.files });
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw new CollabError("SNAPSHOT_INVALID", "Unable to capture Review Point diff");
    }
  }

  async readSnapshotChunk(input: { roomId: string; principalId: string; snapshotId: string; fileIndex: number; offset: number; length: number }): Promise<{ snapshot: WorkspaceSnapshotPackage; bytes: Uint8Array }> {
    const snapshot = await this.getSnapshot(input);
    const file = snapshot.files[input.fileIndex];
    if (!file || input.offset > file.size) throw new CollabError("INVALID_INPUT", "Workspace Snapshot chunk range is invalid");
    return { snapshot, bytes: await this.requireSnapshots().readChunk(snapshot.snapshotId, file.path, input.offset, input.length) };
  }

  private requireSnapshots(): WorkspaceSnapshotProvider {
    if (!this.options.snapshots) throw new CollabError("SNAPSHOT_NOT_FOUND", "Workspace Snapshot transport is unavailable");
    return this.options.snapshots;
  }

  private currentState(roomId: string): WorkspaceSharingState {
    const state = this.options.registry.get(roomId);
    if (state.enabled) return state;
    return {
      roomId,
      enabled: false,
      revision: Math.max(state.revision, this.options.ledger.latestCommittedSeq(roomId)),
    };
  }

  private assertRoomSnapshot(snapshot: WorkspaceSnapshotPackage, roomId: string, hostSessionId?: string): WorkspaceSnapshotPackage {
    if (snapshot.roomId !== roomId || (hostSessionId !== undefined && snapshot.hostSessionId !== hostSessionId)) {
      throw new CollabError("SNAPSHOT_NOT_FOUND", "Workspace Snapshot does not belong to this room");
    }
    return structuredClone(snapshot);
  }
}
