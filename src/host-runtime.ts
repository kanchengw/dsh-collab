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

export interface DshCollabHostRuntimeOptions {
  roomId: string;
  hostId: string;
  hostSessionId: string;
  title: string;
  hostDisplayName: string;
  sessions: DshSessionService;
  now?: () => number;
  tokenFactory?: () => string;
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

export type DshCollabHostRuntimeSnapshot = CollabRuntimeSnapshot;

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

/** Build the one Host room runtime used by a DSH process or a local E2E harness. */
export function createDshCollabHostRuntime(options: DshCollabHostRuntimeOptions): DshCollabHostRuntime {
  const rooms = options.snapshot ? RoomStore.fromSnapshot(options.snapshot.rooms) : new RoomStore();
  if (!options.snapshot) {
    rooms.createRoom({ roomId: options.roomId, hostId: options.hostId, hostSessionId: options.hostSessionId, title: options.title, hostDisplayName: options.hostDisplayName, now: options.now?.() });
  }
  const ledger = options.snapshot ? EventLedger.fromSnapshot(options.snapshot.ledger) : new EventLedger();
  const invites = new InviteStore(rooms, { tokenFactory: options.tokenFactory });
  const approvals = options.snapshot?.approvals
    ? ApprovalStore.fromSnapshot({ rooms, ledger, answerer: options.approvalAnswerer, snapshot: options.snapshot.approvals })
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
  });
  if (options.snapshot) gateway.dispatcher.restore(options.snapshot.dispatcher);
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
    snapshot: () => collabRuntime.snapshot(),
    async dispose(): Promise<void> {
      await upgrade.close();
      http.server.off("upgrade", upgrade.handleUpgrade);
      await http.close();
      hub.dispose();
    },
  };
}
