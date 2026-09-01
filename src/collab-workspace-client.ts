import { validateCollabChangesSnapshot, type CollabChangesPort, type CollabChangesSnapshot } from "./collab-changes.js";
import { validateCollabReviewsSnapshot, type CollabReviewsPort, type CollabReviewsSnapshot } from "./collab-reviews.js";
import type { DshCollabClientSnapshot } from "./dsh-client.js";
import type { RoomEventType } from "./types.js";

interface WorkspaceRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

interface WorkspaceRoomSource {
  getSnapshot(): DshCollabClientSnapshot;
  subscribe(listener: () => void): () => void;
  getWorkspaceSharing?(roomId: string): Promise<{ enabled: boolean }>;
  setWorkspaceSharing?(roomId: string, enabled: boolean): Promise<{ enabled: boolean }>;
  getLocalSnapshotAccess(roomId: string): { gatewayEndpoint: string; roomToken: string };
}

interface WorkspaceProjection {
  changes: CollabChangesSnapshot;
  reviews: CollabReviewsSnapshot;
}

export interface OpenParticipantRoomWorkspaceInput {
  roomId: string;
  path: string;
  gatewayEndpoint: string;
  roomTitle: string;
  hostDisplayName: string;
}

interface WorkspacePortsInput {
  sessionId: string;
  rpc: WorkspaceRpc;
  source: WorkspaceRoomSource;
  openWorkspace?: (input: OpenParticipantRoomWorkspaceInput) => Promise<void>;
}

interface ActiveRoomBinding {
  roomId: string;
  memberId: string;
  role: DshCollabClientSnapshot["role"];
  generation: number;
}

const WORKSPACE_REFRESH_EVENTS = new Set<RoomEventType>([
  "workspace-sharing.changed",
  "changeset.submitted",
  "changeset.review-assigned",
  "changeset.finding-created",
  "changeset.review-decided",
  "changeset.revision-linked",
  "changeset.applied",
  "changeset.apply-conflicted",
]);

function fallback(source: WorkspaceRoomSource): WorkspaceProjection {
  const room = source.getSnapshot();
  const roomId = room.roomId.trim() || "unselected";
  const currentMemberId = room.memberId?.trim() || "local-member";
  const members = room.members?.some((member) => member.memberId === currentMemberId)
    ? [...room.members]
    : [...(room.members ?? []), { memberId: currentMemberId, displayName: currentMemberId }];
  return {
    changes: {
      roomId,
      role: room.role === "host" ? "owner" : "participant",
      connection: room.connection === "online" ? "online" : "offline",
      workspace: room.role === "host" ? { kind: "owner" } : { kind: "unavailable" },
      staged: [],
    },
    reviews: {
      roomId,
      role: room.role === "host" ? "owner" : "participant",
      currentMemberId,
      connection: room.connection === "online" ? "online" : "offline",
      members,
      reviews: [],
    },
  };
}

function roomIdentity(source: WorkspaceRoomSource): string {
  const room = source.getSnapshot();
  return `${room.roomId}\0${room.memberId ?? ""}\0${room.role}\0${room.connection}`;
}

function rpcValue(value: unknown): WorkspaceProjection {
  const envelope = value as { ok?: unknown; value?: { changes?: unknown; reviews?: unknown }; error?: { message?: unknown } };
  if (!envelope || envelope.ok !== true || !envelope.value) {
    throw new Error(typeof envelope?.error?.message === "string" ? envelope.error.message : "Collab workspace request failed");
  }
  return {
    changes: validateCollabChangesSnapshot(envelope.value.changes as CollabChangesSnapshot),
    reviews: validateCollabReviewsSnapshot(envelope.value.reviews as CollabReviewsSnapshot),
  };
}

class SessionWorkspacePorts {
  private projection: WorkspaceProjection;
  private readonly changesListeners = new Set<() => void>();
  private readonly reviewsListeners = new Set<() => void>();
  private activeRoom?: ActiveRoomBinding;
  private activationGeneration = 0;
  private pending = Promise.resolve();
  private roomRefreshRunning = false;
  private roomRefreshPending?: ActiveRoomBinding;
  private disposed = false;

  readonly changes: CollabChangesPort;
  readonly reviews: CollabReviewsPort;

  constructor(private readonly input: WorkspacePortsInput) {
    this.projection = fallback(input.source);
    this.changes = {
      getSnapshot: () => this.projection.changes,
      subscribe: (listener) => this.subscribe(this.changesListeners, listener),
      refresh: async () => { await this.refresh(); },
      ...(input.openWorkspace ? { openWorkspace: async () => { await this.openWorkspace(); } } : {}),
      ...(input.source.setWorkspaceSharing ? { setWorkspaceSharing: async (enabled: boolean) => { await this.setWorkspaceSharing(enabled); } } : {}),
      sync: async () => { await this.run("workspace/changes/sync", {}); },
      discardAndSync: async () => { await this.run("workspace/changes/discard-sync", {}); },
      createDraft: async (draft) => { await this.run("workspace/changes/create-draft", draft); },
      submitDraft: async () => { await this.run("workspace/changes/submit", {}); },
      selectChangeSet: async (changeSetId) => { await this.run("workspace/changes/select", { changeSetId }); },
    };
    this.reviews = {
      getSnapshot: () => this.projection.reviews,
      subscribe: (listener) => this.subscribe(this.reviewsListeners, listener),
      refresh: async () => { await this.run("workspace/refresh", {}); },
      selectReview: async (changeSetId) => { await this.run("workspace/reviews/select", { changeSetId }); },
      assignReviewer: async (changeSetId, reviewerId) => { await this.run("workspace/reviews/assign", { changeSetId, reviewerId }); },
      createFinding: async (changeSetId, finding) => { await this.run("workspace/reviews/finding", { changeSetId, ...finding }); },
      decide: async (changeSetId, outcome, note) => { await this.run("workspace/reviews/decide", { changeSetId, outcome, ...(note ? { note } : {}) }); },
      apply: async (changeSetId) => { await this.run("workspace/reviews/apply", { changeSetId }); },
    };
  }

  reset(): void {
    if (this.disposed) return;
    this.activationGeneration += 1;
    this.activeRoom = undefined;
    this.roomRefreshPending = undefined;
    this.projection = fallback(this.input.source);
    this.emit();
  }

  async activate(roomId: string): Promise<void> {
    this.assertNotDisposed();
    const room = this.assertRoom(roomId);
    const binding = { roomId, memberId: room.memberId, role: room.role, generation: ++this.activationGeneration };
    this.activeRoom = binding;
    await this.enqueue(async () => {
      this.assertBinding(binding);
      await this.refreshProjection(binding);
    });
  }

  syncContext(roomId: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Collab workspace ports are disposed"));
    const binding = this.activeRoom;
    if (!binding || binding.roomId !== roomId) return Promise.resolve();
    return this.enqueue(async () => {
      this.assertBinding(binding);
      await this.call(binding, "workspace/context-sync", {});
    });
  }

  refreshForRoomEvent(roomId: string): void {
    if (this.disposed) return;
    const binding = this.activeRoom;
    if (!binding || binding.roomId !== roomId) return;
    this.roomRefreshPending = binding;
    if (this.roomRefreshRunning) return;
    this.roomRefreshRunning = true;
    void this.drainRoomRefreshes();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activationGeneration += 1;
    this.activeRoom = undefined;
    this.roomRefreshPending = undefined;
    this.changesListeners.clear();
    this.reviewsListeners.clear();
  }

  private subscribe(listeners: Set<() => void>, listener: () => void): () => void {
    this.assertNotDisposed();
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  private async run(endpoint: string, action: Record<string, unknown>): Promise<void> {
    this.assertNotDisposed();
    const binding = this.requireActiveRoom();
    await this.enqueue(() => this.runNow(binding, endpoint, action));
  }

  private async refresh(): Promise<void> {
    this.assertNotDisposed();
    const binding = this.requireActiveRoom();
    await this.enqueue(() => this.refreshProjection(binding));
  }

  private async refreshProjection(binding: ActiveRoomBinding): Promise<void> {
    const workspaceSharingEnabled = await this.refreshWorkspaceSharing(binding);
    if (workspaceSharingEnabled === false) {
      this.emit();
      return;
    }
    await this.runNow(binding, "workspace/refresh", {});
  }

  private async runNow(binding: ActiveRoomBinding, endpoint: string, action: Record<string, unknown>): Promise<void> {
    const value = await this.call(binding, endpoint, action);
    this.assertBinding(binding);
    this.projection = this.withWorkspaceSharing(rpcValue(value));
    this.emit();
  }

  private async setWorkspaceSharing(enabled: boolean): Promise<void> {
    const binding = this.requireActiveRoom();
    await this.enqueue(async () => {
      this.assertBinding(binding);
      if (binding.role !== "host" || !this.input.source.setWorkspaceSharing) throw new Error("Only the Owner can change Workspace Sharing");
      const state = await this.input.source.setWorkspaceSharing(binding.roomId, enabled);
      this.assertBinding(binding);
      this.projection = { ...this.projection, changes: { ...this.projection.changes, workspaceSharingEnabled: state.enabled } };
      this.emit();
    });
  }

  private async openWorkspace(): Promise<void> {
    const binding = this.requireActiveRoom();
    await this.enqueue(async () => {
      this.assertBinding(binding);
      const workspace = this.projection.changes.workspace;
      const room = this.input.source.getSnapshot();
      if (!this.input.openWorkspace || binding.role !== "participant" || workspace.kind !== "ready") {
        throw new Error("The selected Participant Room Workspace is unavailable");
      }
      if (workspace.linked) return;
      if (!room.gatewayEndpoint) throw new Error("The selected collaboration room endpoint is unavailable");
      await this.input.openWorkspace({
        roomId: binding.roomId,
        path: workspace.path,
        gatewayEndpoint: room.gatewayEndpoint,
        roomTitle: room.roomTitle,
        hostDisplayName: room.hostDisplayName,
      });
    });
  }

  private async refreshWorkspaceSharing(binding: ActiveRoomBinding): Promise<boolean | undefined> {
    if (!this.input.source.getWorkspaceSharing) return undefined;
    const state = await this.input.source.getWorkspaceSharing(binding.roomId);
    this.assertBinding(binding);
    this.projection = { ...this.projection, changes: { ...this.projection.changes, workspaceSharingEnabled: state.enabled } };
    return state.enabled;
  }

  private withWorkspaceSharing(projection: WorkspaceProjection): WorkspaceProjection {
    const enabled = this.input.source.getSnapshot().workspaceSharing?.enabled;
    return enabled === undefined ? projection : { ...projection, changes: { ...projection.changes, workspaceSharingEnabled: enabled } };
  }

  private async call(binding: ActiveRoomBinding, endpoint: string, action: Record<string, unknown>): Promise<unknown> {
    this.assertBinding(binding);
    const room = this.input.source.getSnapshot();
    const remote = this.input.source.getLocalSnapshotAccess(binding.roomId);
    const value = await this.input.rpc.call("/dsh-collab", endpoint, {
      sessionId: this.input.sessionId,
      room: {
        roomId: binding.roomId,
        memberId: binding.memberId,
        role: binding.role,
        connection: room.connection,
        members: room.members ?? [],
        roomEvents: room.roomEvents ?? [],
      },
      remote,
      action,
    });
    this.assertBinding(binding);
    return value;
  }

  private assertRoom(roomId: string): DshCollabClientSnapshot & { memberId: string } {
    const room = this.input.source.getSnapshot();
    if (room.roomId !== roomId || room.connection !== "online" || !room.memberId) {
      throw new Error("The selected collaboration room is not connected");
    }
    return room as DshCollabClientSnapshot & { memberId: string };
  }

  private requireActiveRoom(): ActiveRoomBinding {
    this.assertNotDisposed();
    const binding = this.activeRoom;
    if (!binding) throw new Error("The selected collaboration room is not connected");
    this.assertBinding(binding);
    return binding;
  }

  private assertBinding(binding: ActiveRoomBinding): void {
    this.assertNotDisposed();
    const room = this.assertRoom(binding.roomId);
    if (this.activeRoom?.generation !== binding.generation || room.memberId !== binding.memberId || room.role !== binding.role) {
      throw new Error("The selected collaboration room is not connected");
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Collab workspace ports are disposed");
  }

  private async drainRoomRefreshes(): Promise<void> {
    try {
      while (this.roomRefreshPending) {
        const binding = this.roomRefreshPending;
        this.roomRefreshPending = undefined;
        await this.enqueue(() => this.refreshProjection(binding)).catch(() => undefined);
      }
    } finally {
      this.roomRefreshRunning = false;
      if (this.roomRefreshPending) this.refreshForRoomEvent(this.roomRefreshPending.roomId);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private emit(): void {
    for (const listener of this.changesListeners) listener();
    for (const listener of this.reviewsListeners) listener();
  }
}

export class DshCollabWorkspacePorts {
  private readonly sessions = new Map<string, SessionWorkspacePorts>();
  private readonly removeSourceListener: () => void;
  private sourceIdentity: string;
  private lastEventSeq: number;
  private disposed = false;

  constructor(private readonly input: { rpc: WorkspaceRpc; source: WorkspaceRoomSource; openWorkspace?: (input: OpenParticipantRoomWorkspaceInput) => Promise<void> }) {
    this.sourceIdentity = roomIdentity(input.source);
    this.lastEventSeq = this.maxEventSeq();
    this.removeSourceListener = input.source.subscribe(() => {
      if (this.disposed) return;
      const nextIdentity = roomIdentity(input.source);
      if (nextIdentity !== this.sourceIdentity) {
        this.sourceIdentity = nextIdentity;
        this.lastEventSeq = this.maxEventSeq();
        for (const ports of this.sessions.values()) ports.reset();
        return;
      }
      const snapshot = input.source.getSnapshot();
      const nextEventSeq = this.maxEventSeq();
      if (nextEventSeq <= this.lastEventSeq) return;
      const newEvents = (snapshot.roomEvents ?? []).filter((event) => event.seq > this.lastEventSeq);
      this.lastEventSeq = nextEventSeq;
      for (const ports of this.sessions.values()) {
        if (newEvents.some((event) => WORKSPACE_REFRESH_EVENTS.has(event.type))) ports.refreshForRoomEvent(snapshot.roomId);
        else void ports.syncContext(snapshot.roomId).catch(() => undefined);
      }
    });
  }

  async activateSession(sessionId: string, roomId: string): Promise<void> {
    this.assertNotDisposed();
    await this.session(sessionId).activate(roomId);
  }

  forSession(sessionId: string): { changes: CollabChangesPort; reviews: CollabReviewsPort } {
    this.assertNotDisposed();
    const ports = this.session(sessionId);
    return { changes: ports.changes, reviews: ports.reviews };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeSourceListener();
    for (const ports of this.sessions.values()) ports.dispose();
    this.sessions.clear();
  }

  private session(sessionId: string): SessionWorkspacePorts {
    this.assertNotDisposed();
    let ports = this.sessions.get(sessionId);
    if (!ports) {
      ports = new SessionWorkspacePorts({ sessionId, rpc: this.input.rpc, source: this.input.source, ...(this.input.openWorkspace ? { openWorkspace: this.input.openWorkspace } : {}) });
      this.sessions.set(sessionId, ports);
    }
    return ports;
  }

  private maxEventSeq(): number {
    return Math.max(0, ...(this.input.source.getSnapshot().roomEvents ?? []).map((event) => event.seq));
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Collab workspace ports are disposed");
  }
}
