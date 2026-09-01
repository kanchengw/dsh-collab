import { randomUUID } from "node:crypto";
import { ChangeSetClient } from "./collaboration-client.js";
import type { StagedChangeSet } from "./change-set-staging.js";
import type { CollabChangesSnapshot } from "./collab-changes.js";
import type { CollabReviewItem, CollabReviewsSnapshot } from "./collab-reviews.js";
import type { ChangeSetReview, ChangeSetReviewFinding, ChangeSetReviewFindingPage, ChangeSetReviewPage } from "./change-set-reviews.js";
import { ChangeSetDraftService, ChangeSetDraftStore } from "./change-sets.js";
import { CHANGE_SET_CAPABILITY, WORKSPACE_VERSION_CAPABILITY } from "./collaboration-types.js";
import { ensureRoomWorkspaceGitBaseline } from "./dsh-room-workspace.js";
import { DshRoomWorkspaceBindingService, type DshNativeWorkspaceRegistry } from "./dsh-room-workspace.js";
import { bindDshNativeAgentContext, type DshNativeAgentSessionEventListener } from "./dsh-native-agent-context.js";
import { bindCollabPublishUpdateTool, GatewayWorkUpdatePublisher, type CollabPublishUpdateToolBinding, type DshCollabToolAgentRegistry } from "./dsh-collab-tools.js";
import { gatewayHttpUrl } from "./endpoint-policy.js";
import type { ParticipantGatewayTransport } from "./participant.js";
import { resolveDefaultCollabRoomWorkspaceDir, resolveDefaultCollabSnapshotDir } from "./persistence.js";
import type { DshRepositorySubprocess } from "./repository-inspector.js";
import { findRoomWorkspaceChangedPaths, RoomWorkspaceMaterializer } from "./room-workspace.js";
import { RoomWorkspaceSyncService } from "./room-workspace-sync.js";
import { projectRoomContext } from "./room-context.js";
import { RoomContextDeliveryCoordinator } from "./room-context-delivery.js";
import { resolveDefaultRoomSessionLinkFile, RoomSessionLinkFile, RoomSessionLinkStore } from "./room-session-links.js";
import type { RoomEvent } from "./types.js";
import { WorkspaceSnapshotStore } from "./workspace-snapshot-store.js";
import { WorkspaceVersionClient } from "./workspace-version-transport.js";
import { validateWorkspaceVersionRecord, type WorkspaceVersionRecord } from "./workspace-versions.js";

type NodeFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface DshWorkspaceControlRequest {
  sessionId: string;
  room: {
    roomId: string;
    memberId: string;
    role: "host" | "participant";
    connection: "online";
    members: readonly { memberId: string; displayName: string }[];
    roomEvents: RoomEvent[];
  };
  remote: { gatewayEndpoint: string; roomToken: string };
  action: Record<string, unknown>;
}

type RoomContextSyncRequest = Pick<DshWorkspaceControlRequest, "sessionId" | "room">;

interface PendingRequest {
  clientRequestId: string;
  active: number;
  failureGeneration: number;
  resolvedFailureGeneration: number;
  invalidated: boolean;
  workspaceParentCaptured?: boolean;
  workspaceParentVersionId?: string;
}

interface RequestLease<T> {
  key: string;
  pending: PendingRequest;
  retryGeneration: number;
  result: T;
  onConfirmed?: (projection: { changes: CollabChangesSnapshot; reviews: CollabReviewsSnapshot }) => Promise<void>;
}

class DefinitiveRequestFailure extends Error {}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function hashId(value: unknown, field: string): string {
  const id = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`${field} is invalid`);
  return id;
}

function controlRequest(value: unknown): DshWorkspaceControlRequest {
  const request = value as DshWorkspaceControlRequest;
  if (!request || typeof request !== "object" || Array.isArray(request) || !request.room || !request.remote || !request.action) {
    throw new Error("Collab workspace request is invalid");
  }
  text(request.sessionId, "sessionId");
  text(request.room.roomId, "roomId");
  text(request.room.memberId, "memberId");
  if (request.room.role !== "host" && request.room.role !== "participant") throw new Error("room role is invalid");
  if (request.room.connection !== "online" || !Array.isArray(request.room.members) || !Array.isArray(request.room.roomEvents)) throw new Error("room state is invalid");
  text(request.remote.gatewayEndpoint, "gatewayEndpoint");
  text(request.remote.roomToken, "roomToken");
  return request;
}

function remoteTransport(endpoint: string, fetcher: NodeFetch): ParticipantGatewayTransport {
  const base = gatewayHttpUrl(endpoint).replace(/\/$/, "");
  return {
    async request(input) {
      const response = await fetcher(`${base}${input.path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${input.token}`,
          ...(input.capabilities?.length ? { "x-dsh-collab-capabilities": input.capabilities.join(",") } : {}),
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const envelope = await response.json() as { data?: unknown; error?: unknown };
      return { status: response.status, body: response.status >= 400 ? envelope.error : envelope.data };
    },
  };
}

function body<T>(response: { status: number; body: unknown }, operation: string): T {
  if (response.status >= 400) {
    const error = response.body as { message?: unknown };
    throw new Error(typeof error?.message === "string" ? error.message : `${operation} failed (${String(response.status)})`);
  }
  return response.body as T;
}

export class DshWorkspaceControl {
  private readonly artifacts: WorkspaceSnapshotStore;
  private readonly materializer: RoomWorkspaceMaterializer;
  private readonly syncService: RoomWorkspaceSyncService;
  private readonly fetcher: NodeFetch;
  private readonly selectedChanges = new Map<string, string>();
  private readonly selectedReviews = new Map<string, string>();
  private readonly links: RoomSessionLinkStore;
  private readonly linkFile?: RoomSessionLinkFile;
  private readonly contextDeliveries = new Map<string, RoomContextDeliveryCoordinator>();
  private readonly latestContextRequests = new Map<string, RoomContextSyncRequest>();
  private readonly updateTools = new Map<string, CollabPublishUpdateToolBinding>();
  private readonly roomAccess = new Map<string, { gatewayEndpoint: string; roomToken: string }>();
  private readonly pendingRequestIds = new Map<string, PendingRequest>();

  constructor(private readonly options: {
    subprocess: DshRepositorySubprocess;
    roomWorkspaceRoot?: string;
    artifactRoot?: string;
    fetch?: NodeFetch;
    agents?: { get(sessionId: string): { id?: string; ctx?: unknown; session?: { events: readonly { seq: number; type: string; data: unknown }[]; header?: { cwd?: string; seedLength?: number } }; inject?(message: unknown): void } | undefined };
    onSessionEvent?: (listener: DshNativeAgentSessionEventListener) => () => void;
    nativeWorkspaces?: DshNativeWorkspaceRegistry;
    sessionLinkFile?: string | false;
  }) {
    this.artifacts = new WorkspaceSnapshotStore(options.artifactRoot ?? resolveDefaultCollabSnapshotDir());
    this.materializer = new RoomWorkspaceMaterializer({ root: options.roomWorkspaceRoot ?? resolveDefaultCollabRoomWorkspaceDir(), artifacts: this.artifacts });
    this.syncService = new RoomWorkspaceSyncService({ roomWorkspaces: this.materializer, artifacts: this.artifacts, subprocess: options.subprocess });
    this.fetcher = options.fetch ?? (globalThis.fetch as unknown as NodeFetch);
    if (!this.fetcher) throw new Error("fetch is unavailable");
    this.linkFile = options.sessionLinkFile === false ? undefined : new RoomSessionLinkFile(options.sessionLinkFile ?? resolveDefaultRoomSessionLinkFile());
    const snapshot = this.linkFile?.loadSync();
    this.links = snapshot ? RoomSessionLinkStore.fromSnapshot(snapshot) : new RoomSessionLinkStore();
  }

  async handle(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<
    | { synced: true }
    | { changes: CollabChangesSnapshot; reviews: CollabReviewsSnapshot }
  > {
    const request = controlRequest(payload);
    this.roomAccess.set(request.room.roomId, request.remote);
    if (endpoint === "workspace/context-sync") {
      await this.syncContext(request);
      return { synced: true };
    }
    const transport = remoteTransport(request.remote.gatewayEndpoint, this.fetcher);
    let lease: RequestLease<unknown> | undefined;
    try {
      switch (endpoint) {
        case "workspace/refresh": break;
        case "workspace/changes/sync": lease = await this.sync(request, transport, false, signal); break;
        case "workspace/changes/discard-sync": lease = await this.sync(request, transport, true, signal); break;
        case "workspace/changes/create-draft": await this.createDraft(request); break;
        case "workspace/changes/submit": lease = await this.submitDraft(request, transport, signal); break;
        case "workspace/changes/select": this.selectedChanges.set(request.room.roomId, hashId(request.action.changeSetId, "changeSetId")); break;
        case "workspace/reviews/select": this.selectedReviews.set(request.room.roomId, hashId(request.action.changeSetId, "changeSetId")); break;
        case "workspace/reviews/assign": lease = await this.reviewAction(request, transport, "PUT", "reviewer", {
          reviewerId: text(request.action.reviewerId, "reviewerId"),
        }, signal); break;
        case "workspace/reviews/finding": lease = await this.reviewAction(request, transport, "POST", "findings", {
          severity: request.action.severity, location: request.action.location, body: text(request.action.body, "body"),
        }, signal); break;
        case "workspace/reviews/decide": lease = await this.reviewAction(request, transport, "POST", "decisions", {
          outcome: request.action.outcome, ...(request.action.note ? { note: text(request.action.note, "note") } : {}),
        }, signal); break;
        case "workspace/reviews/apply": lease = await this.reviewAction(request, transport, "POST", "apply", {}, signal); break;
        default: throw new Error(`Unknown dsh-collab workspace endpoint: ${endpoint}`);
      }
      await this.syncContext(request).catch(() => undefined);
      const projection = await this.project(request, transport, signal);
      await lease?.onConfirmed?.(projection);
      if (lease) this.finishRequest(lease, true);
      return projection;
    } catch (cause) {
      if (lease) this.finishRequest(lease, false);
      throw cause;
    }
  }

  async dispose(): Promise<void> {
    for (const binding of this.updateTools.values()) binding.dispose();
    for (const delivery of this.contextDeliveries.values()) delivery.dispose();
    this.updateTools.clear();
    this.contextDeliveries.clear();
    this.latestContextRequests.clear();
    this.roomAccess.clear();
    this.pendingRequestIds.clear();
    await this.linkFile?.flush();
  }

  private async sync(request: DshWorkspaceControlRequest, transport: ParticipantGatewayTransport, discard: boolean, signal?: AbortSignal): Promise<RequestLease<void> | undefined> {
    if (request.room.role === "host") {
      const latest = await this.latest(request, transport, signal);
      const parentVersionId = latest?.version.workspaceVersionId;
      const requestKey = JSON.stringify({ operation: "publish-workspace", roomId: request.room.roomId, memberId: request.room.memberId });
      return await this.withRequestId(requestKey, async (clientRequestId, pending) => {
        if (!pending.workspaceParentCaptured) {
          pending.workspaceParentCaptured = true;
          pending.workspaceParentVersionId = parentVersionId;
        }
        const response = await transport.request({
          method: "POST",
          path: `/v1/rooms/${encodeURIComponent(request.room.roomId)}/workspace-versions`,
          token: request.remote.roomToken,
          capabilities: [WORKSPACE_VERSION_CAPABILITY],
          body: { clientRequestId, ...(pending.workspaceParentVersionId ? { parentVersionId: pending.workspaceParentVersionId } : {}) },
          ...(signal ? { signal } : {}),
        });
        if (response.status >= 400 && response.status < 500) {
          const error = response.body as { message?: unknown };
          throw new DefinitiveRequestFailure(typeof error?.message === "string" ? error.message : `Workspace Version publication failed (${String(response.status)})`);
        }
        body(response, "Workspace Version publication");
      });
    }
    const downloaded = await new WorkspaceVersionClient({ transport, artifacts: this.artifacts }).downloadLatest({
      roomId: request.room.roomId,
      token: request.remote.roomToken,
      ...(signal ? { signal } : {}),
    });
    const current = await this.materializer.open(request.room.roomId);
    if (!current) {
      const workspace = await this.materializer.materialize({ roomId: request.room.roomId, record: downloaded.record });
      await ensureRoomWorkspaceGitBaseline(workspace, this.options.subprocess);
      return;
    }
    const result = discard
      ? await this.syncService.discardAndSync({ roomId: request.room.roomId, target: downloaded.record })
      : await this.syncService.sync({ roomId: request.room.roomId, target: downloaded.record });
    if (result.status === "blocked") throw new Error("Room Workspace has local changes; create a ChangeSet or explicitly discard them");
  }

  private async createDraft(request: DshWorkspaceControlRequest): Promise<void> {
    if (request.room.role !== "participant") throw new Error("Only a Participant creates a local ChangeSet draft");
    const workspace = await this.materializer.open(request.room.roomId);
    if (!workspace) throw new Error("Download the Room Workspace first");
    await new ChangeSetDraftService({ artifacts: this.artifacts, subprocess: this.options.subprocess }).create({
      workspace,
      authorId: request.room.memberId,
      title: text(request.action.title, "title"),
      summary: text(request.action.summary, "summary"),
    });
  }

  private async submitDraft(request: DshWorkspaceControlRequest, transport: ParticipantGatewayTransport, signal?: AbortSignal): Promise<RequestLease<StagedChangeSet>> {
    const workspace = await this.materializer.open(request.room.roomId);
    if (!workspace) throw new Error("Download the Room Workspace first");
    const store = new ChangeSetDraftStore(workspace.draftsPath);
    const draft = (await store.list())[0];
    if (!draft) throw new Error("Create a ChangeSet draft first");
    const requestKey = JSON.stringify({ operation: "submit-change-set", roomId: request.room.roomId, memberId: request.room.memberId, draftId: draft.draft.draftId });
    const lease = await this.withRequestId(requestKey, async (clientRequestId) => await new ChangeSetClient({ transport }).submit({
      roomId: request.room.roomId,
      token: request.remote.roomToken,
      clientRequestId,
      draftId: draft.draft.draftId,
      drafts: store,
      ...(signal ? { signal } : {}),
    }));
    const changeSet = lease.result;
    this.selectedChanges.set(request.room.roomId, changeSet.changeSetId);
    this.selectedReviews.set(request.room.roomId, changeSet.changeSetId);
    return {
      ...lease,
      onConfirmed: async (projection) => {
        if (!projection.changes.staged.some((item) => item.changeSet.changeSetId === changeSet.changeSetId)) {
          throw new Error("Submitted ChangeSet is not present in the room projection");
        }
        await store.remove(draft.draft.draftId);
        if (projection.changes.draft?.draft.draftId === draft.draft.draftId) delete projection.changes.draft;
      },
    };
  }

  private async reviewAction(
    request: DshWorkspaceControlRequest,
    transport: ParticipantGatewayTransport,
    method: "POST" | "PUT",
    resource: string,
    action: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RequestLease<void>> {
    const changeSetId = hashId(request.action.changeSetId, "changeSetId");
    const requestKey = JSON.stringify({ roomId: request.room.roomId, memberId: request.room.memberId, method, resource, changeSetId, action });
    const lease = await this.withRequestId(requestKey, async (clientRequestId) => {
      body(await transport.request({
        method,
        path: `/v1/rooms/${encodeURIComponent(request.room.roomId)}/change-sets/${changeSetId}/${resource}`,
        token: request.remote.roomToken,
        capabilities: [CHANGE_SET_CAPABILITY],
        body: { clientRequestId, ...action },
        ...(signal ? { signal } : {}),
      }), `ChangeSet ${resource}`);
    });
    this.selectedReviews.set(request.room.roomId, changeSetId);
    return lease;
  }

  private async withRequestId<T>(key: string, operation: (clientRequestId: string, pending: PendingRequest) => Promise<T>): Promise<RequestLease<T>> {
    let pending = this.pendingRequestIds.get(key);
    if (!pending || pending.invalidated) {
      pending = { clientRequestId: randomUUID(), active: 0, failureGeneration: 0, resolvedFailureGeneration: 0, invalidated: false };
      this.pendingRequestIds.set(key, pending);
    }
    const retryGeneration = pending.failureGeneration;
    pending.active += 1;
    try {
      const result = await operation(pending.clientRequestId, pending);
      return { key, pending, retryGeneration, result };
    } catch (cause) {
      if (cause instanceof DefinitiveRequestFailure) pending.invalidated = true;
      this.finishRequest({ key, pending, retryGeneration }, false);
      throw cause;
    }
  }

  private finishRequest(lease: Pick<RequestLease<unknown>, "key" | "pending" | "retryGeneration">, succeeded: boolean): void {
    if (this.pendingRequestIds.get(lease.key) !== lease.pending) return;
    lease.pending.active = Math.max(0, lease.pending.active - 1);
    if (succeeded) lease.pending.resolvedFailureGeneration = Math.max(lease.pending.resolvedFailureGeneration, lease.retryGeneration);
    else lease.pending.failureGeneration += 1;
    if (lease.pending.active === 0
      && (lease.pending.invalidated || lease.pending.resolvedFailureGeneration >= lease.pending.failureGeneration)) {
      this.pendingRequestIds.delete(lease.key);
    }
  }

  private async project(request: DshWorkspaceControlRequest, transport: ParticipantGatewayTransport, signal?: AbortSignal): Promise<{ changes: CollabChangesSnapshot; reviews: CollabReviewsSnapshot }> {
    const latest = await this.latest(request, transport, signal);
    const workspace = request.room.role === "participant" ? await this.materializer.open(request.room.roomId) : undefined;
    const draft = workspace ? (await new ChangeSetDraftStore(workspace.draftsPath).list())[0] : undefined;
    const reviewPage = body<ChangeSetReviewPage>(await transport.request({
      method: "GET",
      path: `/v1/rooms/${encodeURIComponent(request.room.roomId)}/change-sets/reviews?limit=100`,
      token: request.remote.roomToken,
      capabilities: [CHANGE_SET_CAPABILITY],
      ...(signal ? { signal } : {}),
    }), "ChangeSet review list");
    const client = new ChangeSetClient({ transport });
    const reviewItems: CollabReviewItem[] = [];
    const staged: Array<CollabChangesSnapshot["staged"][number]> = [];
    const selectedChangeSetId = this.selectedChanges.get(request.room.roomId);
    const selectedReviewId = this.selectedReviews.get(request.room.roomId);
    for (const { review, changeSet } of reviewPage.items ?? []) {
      const patch = selectedChangeSetId === review.changeSetId
        ? await client.readPatch({ roomId: request.room.roomId, token: request.remote.roomToken, changeSetId: review.changeSetId, ...(signal ? { signal } : {}) })
        : undefined;
      const findings = selectedReviewId === review.changeSetId
        ? body<ChangeSetReviewFindingPage>(await transport.request({
            method: "GET",
            path: `/v1/rooms/${encodeURIComponent(request.room.roomId)}/change-sets/${review.changeSetId}/findings?limit=100`,
            token: request.remote.roomToken,
            capabilities: [CHANGE_SET_CAPABILITY],
            ...(signal ? { signal } : {}),
          }), "ChangeSet findings").findings ?? []
        : [];
      staged.push({ changeSet, ...(patch === undefined ? {} : { patch }) });
      reviewItems.push({ review: review as ChangeSetReview, changeSet, findings: findings as ChangeSetReviewFinding[] });
    }
    const latestVersionId = latest?.version.workspaceVersionId;
    const changes: CollabChangesSnapshot = {
      roomId: request.room.roomId,
      role: request.room.role === "host" ? "owner" : "participant",
      connection: "online",
      workspace: request.room.role === "host"
        ? { kind: "owner", ...(latestVersionId ? { latestVersionId } : {}) }
        : workspace
          ? {
              kind: "ready",
              path: workspace.workspacePath,
              baseVersionId: workspace.record.version.workspaceVersionId,
              ...(latestVersionId ? { latestVersionId } : {}),
              dirtyPaths: await findRoomWorkspaceChangedPaths(workspace),
              linked: this.links.getBySession(request.sessionId)?.active === true
                && this.links.getBySession(request.sessionId)?.roomId === request.room.roomId,
            }
          : { kind: "unavailable", ...(latestVersionId ? { latestVersionId } : {}) },
      ...(draft ? { draft } : {}),
      staged,
      ...(selectedChangeSetId ? { selectedChangeSetId } : {}),
    };
    const reviews: CollabReviewsSnapshot = {
      roomId: request.room.roomId,
      role: request.room.role === "host" ? "owner" : "participant",
      currentMemberId: request.room.memberId,
      connection: "online",
      members: request.room.members,
      reviews: reviewItems,
      ...(selectedReviewId ? { selectedChangeSetId: selectedReviewId } : {}),
    };
    return { changes, reviews };
  }

  private async latest(request: DshWorkspaceControlRequest, transport: ParticipantGatewayTransport, signal?: AbortSignal): Promise<WorkspaceVersionRecord | undefined> {
    const response = await transport.request({
      method: "GET",
      path: `/v1/rooms/${encodeURIComponent(request.room.roomId)}/workspace-versions/latest`,
      token: request.remote.roomToken,
      capabilities: [WORKSPACE_VERSION_CAPABILITY],
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) return undefined;
    return validateWorkspaceVersionRecord(body<{ record: unknown }>(response, "Workspace Version lookup").record);
  }

  private async syncContext(request: RoomContextSyncRequest): Promise<void> {
    this.latestContextRequests.set(request.sessionId, structuredClone(request));
    const agent = this.options.agents?.get(request.sessionId);
    const cwd = agent?.session?.header?.cwd;
    if (!agent?.inject || !cwd || !this.options.onSessionEvent) return;
    const participantBindings = request.room.role === "participant" && this.options.nativeWorkspaces
      ? new DshRoomWorkspaceBindingService({
          agents: this.options.agents!,
          nativeWorkspaces: this.options.nativeWorkspaces,
          subprocess: this.options.subprocess,
          roomWorkspaces: this.materializer,
          links: this.links,
        })
      : undefined;

    let link = this.links.getBySession(request.sessionId);
    if (!link) {
      if (request.room.role === "host") {
        link = this.links.bind({
          roomId: request.room.roomId,
          memberId: request.room.memberId,
          sessionId: request.sessionId,
          workspacePath: cwd,
          sessionCwd: cwd,
        });
      } else {
        if (!participantBindings) return;
        const workspace = await this.materializer.open(request.room.roomId);
        if (!workspace) return;
        try {
          link = await participantBindings.bind({ roomId: request.room.roomId, memberId: request.room.memberId, sessionId: request.sessionId });
        } catch (error) {
          if (error instanceof Error && /cwd does not match/i.test(error.message)) return;
          throw error;
        }
      }
      await this.linkFile?.save(this.links.snapshot());
    }
    if (link.roomId === request.room.roomId && link.memberId !== request.room.memberId && participantBindings) {
      try {
        link = await participantBindings.rebindMember({
          roomId: request.room.roomId,
          memberId: request.room.memberId,
          sessionId: request.sessionId,
        });
      } catch (error) {
        if (error instanceof Error && /cwd does not match/i.test(error.message)) return;
        throw error;
      }
      this.contextDeliveries.get(request.sessionId)?.dispose();
      this.contextDeliveries.delete(request.sessionId);
      this.updateTools.get(request.sessionId)?.dispose();
      this.updateTools.delete(request.sessionId);
      await this.linkFile?.save(this.links.snapshot());
    }
    if (!link.active || link.roomId !== request.room.roomId || link.memberId !== request.room.memberId) return;
    this.bindUpdateTool(request.sessionId, link.roomId);

    let delivery = this.contextDeliveries.get(request.sessionId);
    if (!delivery) {
      const boundAgent = { id: request.sessionId, session: agent.session!, inject: (message: unknown) => { agent.inject!(message); } };
      const registry = {
        get: (sessionId: string) => {
          const value = this.options.agents?.get(sessionId);
          return sessionId === request.sessionId && value === agent ? boundAgent : undefined;
        },
      };
      const coordinator = new RoomContextDeliveryCoordinator({
        links: this.links,
        binding: bindDshNativeAgentContext({ agents: registry as Parameters<typeof bindDshNativeAgentContext>[0]["agents"], onSessionEvent: this.options.onSessionEvent, sessionId: request.sessionId }),
        onCursorAdvanced: () => {
          void this.linkFile?.save(this.links.snapshot()).catch(() => undefined);
          queueMicrotask(() => {
            if (this.contextDeliveries.get(request.sessionId) !== coordinator) return;
            const latest = this.latestContextRequests.get(request.sessionId);
            if (latest) void this.syncContext(latest).catch(() => undefined);
          });
        },
      });
      delivery = coordinator;
      this.contextDeliveries.set(request.sessionId, coordinator);
    }
    const current = this.links.getBySession(request.sessionId)!;
    const events = request.room.roomEvents.filter((event) => event.seq > current.lastInjectedRoomSeq);
    const snapshot = projectRoomContext({ roomId: request.room.roomId, afterSeq: current.lastInjectedRoomSeq, events, maxEntries: 50 });
    if (snapshot) delivery.deliver(snapshot);
  }

  private bindUpdateTool(sessionId: string, roomId: string): void {
    if (this.updateTools.has(sessionId) || !this.options.agents) return;
    const candidate = this.options.agents.get(sessionId) as { id?: unknown; ctx?: { tools?: { register?: unknown }; on?: unknown } } | undefined;
    if (candidate?.id !== sessionId || typeof candidate.ctx?.tools?.register !== "function" || typeof candidate.ctx.on !== "function") return;
    const transport: ParticipantGatewayTransport = {
      request: async (input) => {
        const access = [...this.roomAccess.values()].find((value) => value.roomToken === input.token);
        if (!access) throw new Error("Collab room credential is unavailable");
        return await remoteTransport(access.gatewayEndpoint, this.fetcher).request(input);
      },
    };
    const binding = bindCollabPublishUpdateTool({
      agents: this.options.agents as unknown as DshCollabToolAgentRegistry,
      links: this.links,
      sessionId,
      publisher: new GatewayWorkUpdatePublisher({ transport, tokenForRoom: (targetRoomId) => this.roomAccess.get(targetRoomId)?.roomToken }),
    });
    this.updateTools.set(sessionId, binding);
  }
}
