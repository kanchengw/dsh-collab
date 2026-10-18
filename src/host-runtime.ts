import { CollabGateway } from "./gateway.js";
import { EventLedger } from "./events.js";
import { InviteStore } from "./invites.js";
import { ResourceLimiter } from "./limits.js";
import { ApprovalStore } from "./approvals.js";
import { createDshHostAgentPort, type DshSessionService } from "./dsh-host.js";
import { RoomStore } from "./room.js";
import { CollabRuntime, type CollabRuntimeSnapshot } from "./runtime.js";
import { RoomStreamHub } from "./stream.js";
import { CollabStreamUpgrade } from "./upgrade.js";
import { authenticateCollabRequest, createCollabHttpServer, type CollabHttpServer, type HttpHeaders } from "./http.js";
import { ResumeCredentialStore, type ResumeCredentialStoreSnapshot } from "./resume-credentials.js";
import { ActiveRoomRegistry } from "./active-rooms.js";
import { WorkspaceSharingRegistry } from "./workspace-sharing.js";
import { WorkspaceService, type WorkspaceSnapshotProvider } from "./workspace-service.js";
import { ReviewPointService, type ReviewPointServiceSnapshot } from "./review-points.js";
import { MAINLINE_REQUEST_PREFIX, ReviewService, type ReviewServiceSnapshot } from "./reviews.js";
import { WorkUpdateService } from "./work-updates.js";
import { WorkspaceVersionService } from "./workspace-versions.js";
import { ChangeSetStagingService } from "./change-set-staging.js";
import { ChangeSetReviewService, type ChangeSetReviewServiceSnapshot } from "./change-set-reviews.js";
import { ChangeSetApplyPreflightService, type ChangeSetApplyPreflightServiceSnapshot } from "./change-set-apply.js";
import { ChangeSetIntegrationService } from "./change-set-integration.js";
import { DshCanonicalWorkspace, type DshCanonicalFileSystem } from "./canonical-workspace.js";
import { IntegrationJournalStore } from "./integration-journal.js";
import { CollabError } from "./errors.js";
import type { DshRepositorySubprocess } from "./repository-inspector.js";
import type { RoomEvent } from "./types.js";
import { TaskStore, type TaskStoreSnapshot } from "./tasks.js";

export interface DshCollabHostRuntimeOptions {
  roomId?: string;
  hostId: string;
  hostSessionId?: string;
  title?: string;
  hostDisplayName: string;
  sessions: DshSessionService;
  now?: () => number;
  tokenFactory?: () => string;
  resumeCredentialFactory?: () => string;
  tokenTtlMs?: number | null;
  approvalPolicy?: "host-only" | "disabled";
  maxMembers?: number;
  maxMessageBytes?: number;
  maxQueue?: number;
  maxConnections?: number;
  port?: number;
  host?: "127.0.0.1" | "0.0.0.0";
  allowLoopbackPrincipal?: boolean;
  trustedProxyAddresses?: readonly string[];
  trustedPrincipalHeader?: string;
  trustedProxyMarkerHeader?: string;
  principalFromHeaders?: (headers: HttpHeaders) => string | undefined;
  trustedLoopbackOrigins?: readonly string[];
  approvalAnswerer?: object;
  workspaceSnapshots?: WorkspaceSnapshotProvider;
  changeSetRoot?: string;
  changeSetSubprocess?: DshRepositorySubprocess;
  canonicalFiles?: DshCanonicalFileSystem;
  integrationJournalRoot?: string;
  commitCriticalState?: () => Promise<void>;
  snapshot?: DshCollabHostRuntimeSnapshot;
  taskStore?: TaskStore;
  roomContextDelivery?: { onCommitted(event: RoomEvent, ledger: EventLedger): void };
}

export interface DshCollabHostRuntimeSnapshot extends CollabRuntimeSnapshot {
  resumes?: ResumeCredentialStoreSnapshot;
  reviewPoints?: ReviewPointServiceSnapshot;
  reviews?: ReviewServiceSnapshot;
  changeSetReviews?: ChangeSetReviewServiceSnapshot;
  changeSetApply?: ChangeSetApplyPreflightServiceSnapshot;
  tasks?: TaskStoreSnapshot;
}

export interface DshCollabHostRuntime {
  readonly rooms: RoomStore;
  readonly ledger: EventLedger;
  readonly gateway: CollabGateway;
  readonly approvals: ApprovalStore;
  readonly hub: RoomStreamHub;
  readonly upgrade: CollabStreamUpgrade;
  readonly http: CollabHttpServer;
  readonly activeRooms: ActiveRoomRegistry;
  readonly workspace: WorkspaceService;
  readonly workUpdates: WorkUpdateService;
  readonly workspaceVersions?: WorkspaceVersionService;
  readonly changeSets?: ChangeSetStagingService;
  readonly changeSetReviews?: ChangeSetReviewService;
  readonly changeSetApply?: ChangeSetApplyPreflightService;
  readonly changeSetIntegration?: ChangeSetIntegrationService;
  readonly reviewPoints: ReviewPointService;
  readonly reviews: ReviewService;
  readonly taskStore: TaskStore;
  snapshot(): DshCollabHostRuntimeSnapshot;
  commitCriticalState(): Promise<void>;
  recoverPendingIntegrations(): Promise<void>;
  dispose(): Promise<void>;
}

function rebindSnapshot(snapshot: DshCollabHostRuntimeSnapshot, roomId: string, hostSessionId: string): DshCollabHostRuntimeSnapshot {
  const rebound = structuredClone(snapshot);
  const room = rebound.rooms.rooms.find((entry) => entry.room.roomId === roomId);
  if (room) room.room.hostSessionId = hostSessionId;
  for (const record of rebound.dispatcher.records) {
    if (record.roomId === roomId) record.hostSessionId = hostSessionId;
  }
  return rebound;
}

function ledgerHasEventTypes(ledger: EventLedger, types: ReadonlySet<string>): boolean {
  return ledger.snapshot().rooms.some((room) => room.events.some((event) => types.has(event.type)));
}

function restoreWorkspaceSharing(ledger: EventLedger, registry: WorkspaceSharingRegistry): void {
  for (const room of ledger.snapshot().rooms) {
    for (const event of room.events) {
      if (event.type === "workspace-sharing.changed") registry.restore(event.payload as Parameters<WorkspaceSharingRegistry["restore"]>[0]);
    }
  }
}

/** Build the Host runtime used by a DSH process or a local E2E harness. */
export function createDshCollabHostRuntime(options: DshCollabHostRuntimeOptions): DshCollabHostRuntime {
  const snapshot = options.snapshot
    ? options.roomId && options.hostSessionId ? rebindSnapshot(options.snapshot, options.roomId, options.hostSessionId) : options.snapshot
    : undefined;
  const rooms = snapshot ? RoomStore.fromSnapshot(snapshot.rooms) : new RoomStore();
  if (!snapshot && options.roomId && options.hostSessionId && options.title) {
    rooms.createRoom({ roomId: options.roomId, hostId: options.hostId, hostSessionId: options.hostSessionId, title: options.title, hostDisplayName: options.hostDisplayName, now: options.now?.() });
  }
  const ledger = snapshot ? EventLedger.fromSnapshot(snapshot.ledger) : new EventLedger();
  const taskStore = snapshot?.tasks ? TaskStore.fromSnapshot(snapshot.tasks) : options.taskStore ?? new TaskStore();
  const workUpdates = new WorkUpdateService({ rooms, ledger, now: options.now });
  const invites = new InviteStore(rooms, { tokenFactory: options.tokenFactory });
  const resumes = snapshot?.resumes
    ? ResumeCredentialStore.fromSnapshot(rooms, snapshot.resumes)
    : new ResumeCredentialStore(rooms, { credentialFactory: options.resumeCredentialFactory });
  const approvals = snapshot?.approvals
    ? ApprovalStore.fromSnapshot({ rooms, ledger, answerer: options.approvalAnswerer, snapshot: snapshot.approvals })
    : new ApprovalStore({ rooms, ledger, answerer: options.approvalAnswerer });
  // The protocol can model multiple saved rooms, but one DSH runtime owns one active room in the MVP.
  const activeRooms = new ActiveRoomRegistry({ maxActiveRooms: 1 });
  const workspaceSharing = new WorkspaceSharingRegistry();
  restoreWorkspaceSharing(ledger, workspaceSharing);
  const workspace = new WorkspaceService({ rooms, ledger, registry: workspaceSharing, snapshots: options.workspaceSnapshots, now: options.now });
  const workspaceVersions = options.workspaceSnapshots?.readFile
    ? new WorkspaceVersionService({
        rooms,
        ledger,
        artifacts: {
          load: (snapshotId) => options.workspaceSnapshots!.load(snapshotId),
          readFile: (snapshotId, path) => options.workspaceSnapshots!.readFile!(snapshotId, path),
        },
      })
    : undefined;
  const changeSets = workspaceVersions && options.changeSetRoot && options.changeSetSubprocess
    ? new ChangeSetStagingService({
        root: options.changeSetRoot,
        rooms,
        workspaceVersions,
        artifacts: {
          load: (snapshotId) => options.workspaceSnapshots!.load(snapshotId),
          readFile: (snapshotId, path) => options.workspaceSnapshots!.readFile!(snapshotId, path),
        },
        subprocess: options.changeSetSubprocess,
        now: options.now,
      })
    : undefined;
  const reviewEventTypes = new Set([
    "changeset.submitted",
    "changeset.review-assigned",
    "changeset.finding-created",
    "changeset.review-decided",
    "changeset.revision-linked",
    "changeset.applied",
  ]);
  if (!changeSets && (snapshot?.changeSetReviews || ledgerHasEventTypes(ledger, reviewEventTypes))) {
    throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review state requires ChangeSet staging");
  }
  const changeSetReviews = changeSets
    ? snapshot
      ? ChangeSetReviewService.fromSnapshot({ rooms, changeSets, ledger, now: options.now }, snapshot.changeSetReviews ?? { version: 1, reviews: [] })
      : new ChangeSetReviewService({ rooms, changeSets, ledger, now: options.now })
    : undefined;
  const canonicalWorkspace = options.canonicalFiles
    && options.changeSetSubprocess
    ? new DshCanonicalWorkspace({ rooms, sessions: options.sessions, fs: options.canonicalFiles, subprocess: options.changeSetSubprocess })
    : undefined;
  const integrationJournals = options.integrationJournalRoot ? new IntegrationJournalStore(options.integrationJournalRoot) : undefined;
  if ((!changeSets || !changeSetReviews || !canonicalWorkspace || !integrationJournals)
    && (snapshot?.changeSetApply || ledgerHasEventTypes(ledger, new Set(["changeset.apply-conflicted"])))) {
    throw new CollabError("SNAPSHOT_INVALID", "ChangeSet apply state requires canonical integration services");
  }
  const changeSetApply = changeSets && changeSetReviews && canonicalWorkspace && integrationJournals
    ? snapshot
      ? ChangeSetApplyPreflightService.fromSnapshot({ rooms, ledger, changeSets, reviews: changeSetReviews, workspace: canonicalWorkspace, now: options.now }, snapshot.changeSetApply ?? { version: 1, conflicts: [] })
      : new ChangeSetApplyPreflightService({ rooms, ledger, changeSets, reviews: changeSetReviews, workspace: canonicalWorkspace, now: options.now })
    : undefined;
  const changeSetIntegration = changeSetApply && changeSetReviews && canonicalWorkspace && integrationJournals && workspaceVersions && options.commitCriticalState
    ? new ChangeSetIntegrationService({
      rooms,
      ledger,
      preflight: changeSetApply,
        journals: integrationJournals,
        workspace: canonicalWorkspace,
        reviews: changeSetReviews,
        versions: workspaceVersions,
        snapshots: {
          capture: async (input) => await workspace.captureLatest({
            roomId: input.roomId,
            principalId: input.principalId,
            clientRequestId: input.clientRequestId,
            purpose: "workspace-version",
            roomEventSeq: ledger.latestSeq(input.roomId),
          }),
        },
        commitCriticalState: () => ledger.commit(options.commitCriticalState),
      })
    : undefined;
  if (changeSetReviews && workspaceVersions) {
    for (const application of changeSetReviews.listApplications()) {
      if (!workspaceVersions.get(application.roomId, application.workspaceVersionId)) {
        throw new CollabError("SNAPSHOT_INVALID", "ChangeSet application references a missing Workspace Version");
      }
    }
  }
  const reviewPointOptions = {
    rooms,
    ledger,
    snapshots: options.workspaceSnapshots ?? { load: async () => undefined },
    now: options.now,
  };
  const reviewPoints = snapshot?.reviewPoints
    ? ReviewPointService.fromSnapshot(reviewPointOptions, snapshot.reviewPoints)
    : new ReviewPointService(reviewPointOptions);
  const reviewOptions = { rooms, reviewPoints, now: options.now };
  const reviews = snapshot?.reviews
    ? ReviewService.fromSnapshot(reviewOptions, snapshot.reviews)
    : new ReviewService(reviewOptions);
  if (!snapshot && options.roomId && options.hostSessionId && options.title) activeRooms.activate(options.roomId);
  const limits = new ResourceLimiter({
    maxMembersPerRoom: options.maxMembers,
    maxQueuedRequestsPerRoom: options.maxQueue,
    maxConnectionsPerRoom: options.maxConnections ?? 64,
  });
  const gateway = new CollabGateway({
    rooms,
    ledger,
    invites,
    agent: createDshHostAgentPort({ sessions: options.sessions }),
    now: options.now,
    limits,
    tokenFactory: options.tokenFactory,
    tokenTtlMs: options.tokenTtlMs,
    maxMessageBytes: options.maxMessageBytes,
    approvals,
    approvalPolicy: options.approvalPolicy,
    resumes,
    hostPrincipalId: options.hostId,
    hostDisplayName: options.hostDisplayName,
    ownsHostSession: (sessionId) => options.sessions.owns(sessionId),
    activeRooms,
    workspace,
    workUpdates,
    ...(workspaceVersions ? { workspaceVersions } : {}),
    ...(changeSets ? { changeSets } : {}),
    ...(changeSetReviews ? { changeSetReviews } : {}),
    ...(changeSetIntegration ? { changeSetIntegration } : {}),
    ...(options.workspaceSnapshots ? { reviewPoints, reviews } : {}),
    ...(options.commitCriticalState ? { commitCriticalState: options.commitCriticalState } : {}),
  });
  if (snapshot) {
    gateway.dispatcher.restore(snapshot.dispatcher);
    const committedIntegrationRequests = new Set((reviews.snapshot().publications ?? [])
      .filter((publication) => publication.state === "accepted")
      .map((publication) => publication.integrationRequestId!));
    for (const record of gateway.dispatcher.queued()) {
      if (record.requestId.startsWith(MAINLINE_REQUEST_PREFIX) && !committedIntegrationRequests.has(record.requestId)) {
        gateway.dispatcher.failQueuedRequest(record.requestId, "Host recovered an uncommitted Mainline integration request");
      }
    }
    gateway.dispatcher.interruptActive("Host restarted; delivery outcome is unknown");
  }
  const collabRuntime = new CollabRuntime({ rooms, ledger, dispatcher: gateway.dispatcher, approvals });
  const hub = new RoomStreamHub({ rooms, tokens: gateway.tokens, ledger, now: options.now, limits, activeRooms });
  const unsubscribeAgentOutput = options.sessions.onAgentOutput?.((frame) => {
    hub.publishAgentOutput(frame);
  });
  const unsubscribeRoomContextDelivery = options.roomContextDelivery
    ? ledger.subscribeCommitted((event) => { options.roomContextDelivery!.onCommitted(event, ledger); })
    : undefined;
  const upgrade = new CollabStreamUpgrade({ hub, tickets: gateway.streamTickets, now: options.now });
  const http = createCollabHttpServer({
    gateway,
    host: options.host,
    port: options.port,
    ...(options.port === 0 ? {} : { portScan: { start: 4310, end: 4399 } }),
    authenticate: (input) => authenticateCollabRequest(input, {
      hostPrincipalId: options.hostId,
      allowLoopbackPrincipal: options.allowLoopbackPrincipal ?? (options.host ?? "127.0.0.1") === "127.0.0.1",
      trustedProxyAddresses: options.trustedProxyAddresses,
      trustedPrincipalHeader: options.trustedPrincipalHeader,
      trustedProxyMarkerHeader: options.trustedProxyMarkerHeader,
      principalFromHeaders: options.principalFromHeaders,
      trustedLoopbackOrigins: options.trustedLoopbackOrigins,
    }),
  });
  http.server.on("upgrade", upgrade.handleUpgrade);
  return {
    rooms, ledger, gateway, approvals, hub, upgrade, http, activeRooms, workspace, workUpdates, taskStore, ...(workspaceVersions ? { workspaceVersions } : {}), ...(changeSets ? { changeSets } : {}), ...(changeSetReviews ? { changeSetReviews } : {}), ...(changeSetApply ? { changeSetApply } : {}), ...(changeSetIntegration ? { changeSetIntegration } : {}), reviewPoints, reviews,
    snapshot: () => ({
      ...collabRuntime.snapshot(),
      resumes: resumes.snapshot(),
      reviewPoints: reviewPoints.snapshot(),
      reviews: reviews.snapshot(),
      ...(changeSetReviews ? { changeSetReviews: changeSetReviews.snapshot() } : {}),
      ...(changeSetApply ? { changeSetApply: changeSetApply.snapshot() } : {}),
      tasks: taskStore.snapshot(),
    }),
    commitCriticalState: () => ledger.commit(options.commitCriticalState),
    recoverPendingIntegrations: async () => {
      if (changeSetIntegration) {
        await changeSetIntegration.recoverPending();
        return;
      }
      if (integrationJournals && (await integrationJournals.list()).length > 0) {
        throw new CollabError("SNAPSHOT_INVALID", "pending ChangeSet integration cannot be recovered without canonical workspace and persistence services");
      }
    },
    async dispose(): Promise<void> {
      unsubscribeAgentOutput?.();
      unsubscribeRoomContextDelivery?.();
      await upgrade.close();
      http.server.off("upgrade", upgrade.handleUpgrade);
      await http.close();
      hub.dispose();
    },
  };
}
