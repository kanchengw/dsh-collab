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

export interface DshCollabHostRuntimeOptions {
  roomId: string;
  hostId: string;
  hostSessionId: string;
  title: string;
  hostDisplayName: string;
  sessions: DshSessionService;
  now?: () => number;
  tokenFactory?: () => string;
  resumeCredentialFactory?: () => string;
  tokenTtlMs?: number;
  approvalPolicy?: "host-only" | "disabled";
  maxMembers?: number;
  maxMessageBytes?: number;
  maxQueue?: number;
  port?: number;
  host?: "127.0.0.1" | "0.0.0.0";
  allowLoopbackPrincipal?: boolean;
  trustedProxyAddresses?: readonly string[];
  trustedPrincipalHeader?: string;
  trustedProxyMarkerHeader?: string;
  principalFromHeaders?: (headers: HttpHeaders) => string | undefined;
  approvalAnswerer?: object;
  snapshot?: DshCollabHostRuntimeSnapshot;
}

export interface DshCollabHostRuntimeSnapshot extends CollabRuntimeSnapshot {
  resumes?: ResumeCredentialStoreSnapshot;
}

export interface DshCollabHostRuntime {
  readonly rooms: RoomStore;
  readonly ledger: EventLedger;
  readonly gateway: CollabGateway;
  readonly approvals: ApprovalStore;
  readonly hub: RoomStreamHub;
  readonly upgrade: CollabStreamUpgrade;
  readonly http: CollabHttpServer;
  snapshot(): DshCollabHostRuntimeSnapshot;
  dispose(): Promise<void>;
}

function rebindSnapshot(snapshot: DshCollabHostRuntimeSnapshot, roomId: string, hostSessionId: string): DshCollabHostRuntimeSnapshot {
  const rebound = structuredClone(snapshot);
  const room = rebound.rooms.rooms.find((entry) => entry.room.roomId === roomId);
  if (room) room.room.hostSessionId = hostSessionId;
  for (const record of rebound.dispatcher.records) {
    if (record.roomId === roomId) record.hostSessionId = hostSessionId;
  }
  if (rebound.dispatcher.activeRequestId) {
    const active = rebound.dispatcher.records.find((record) => record.requestId === rebound.dispatcher.activeRequestId);
    if (active?.status === "running") {
      active.claimAttempt ??= 1;
      active.status = "queued";
      if (!rebound.dispatcher.queue.includes(active.requestId)) rebound.dispatcher.queue.unshift(active.requestId);
      delete rebound.dispatcher.activeRequestId;
    }
  }
  return rebound;
}

/** Build the one Host room runtime used by a DSH process or a local E2E harness. */
export function createDshCollabHostRuntime(options: DshCollabHostRuntimeOptions): DshCollabHostRuntime {
  const snapshot = options.snapshot ? rebindSnapshot(options.snapshot, options.roomId, options.hostSessionId) : undefined;
  const rooms = snapshot ? RoomStore.fromSnapshot(snapshot.rooms) : new RoomStore();
  if (!snapshot) {
    rooms.createRoom({ roomId: options.roomId, hostId: options.hostId, hostSessionId: options.hostSessionId, title: options.title, hostDisplayName: options.hostDisplayName, now: options.now?.() });
  }
  const ledger = snapshot ? EventLedger.fromSnapshot(snapshot.ledger) : new EventLedger();
  const invites = new InviteStore(rooms, { tokenFactory: options.tokenFactory });
  const resumes = snapshot?.resumes
    ? ResumeCredentialStore.fromSnapshot(rooms, snapshot.resumes)
    : new ResumeCredentialStore(rooms, { credentialFactory: options.resumeCredentialFactory });
  const approvals = snapshot?.approvals
    ? ApprovalStore.fromSnapshot({ rooms, ledger, answerer: options.approvalAnswerer, snapshot: snapshot.approvals })
    : new ApprovalStore({ rooms, ledger, answerer: options.approvalAnswerer });
  const limits = new ResourceLimiter({
    maxMembersPerRoom: options.maxMembers,
    maxQueuedRequestsPerRoom: options.maxQueue,
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
  });
  if (snapshot) {
    gateway.dispatcher.restore(snapshot.dispatcher);
    void gateway.dispatcher.processQueue();
  }
  const collabRuntime = new CollabRuntime({ rooms, ledger, dispatcher: gateway.dispatcher, approvals });
  const hub = new RoomStreamHub({ rooms, tokens: gateway.tokens, ledger, now: options.now, limits });
  const upgrade = new CollabStreamUpgrade({ hub, tokens: gateway.tokens, now: options.now });
  const http = createCollabHttpServer({
    gateway,
    host: options.host,
    port: options.port,
    authenticate: (input) => authenticateCollabRequest(input, {
      hostPrincipalId: options.hostId,
      allowLoopbackPrincipal: options.allowLoopbackPrincipal ?? (options.host ?? "127.0.0.1") === "127.0.0.1",
      trustedProxyAddresses: options.trustedProxyAddresses,
      trustedPrincipalHeader: options.trustedPrincipalHeader,
      trustedProxyMarkerHeader: options.trustedProxyMarkerHeader,
      principalFromHeaders: options.principalFromHeaders,
    }),
  });
  http.server.on("upgrade", upgrade.handleUpgrade);
  return {
    rooms, ledger, gateway, approvals, hub, upgrade, http,
    snapshot: () => ({ ...collabRuntime.snapshot(), resumes: resumes.snapshot() }),
    async dispose(): Promise<void> {
      await upgrade.close();
      http.server.off("upgrade", upgrade.handleUpgrade);
      await http.close();
      hub.dispose();
    },
  };
}
