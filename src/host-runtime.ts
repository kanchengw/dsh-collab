import { CollabGateway } from "./gateway.js";
import { EventLedger } from "./events.js";
import { InviteStore } from "./invites.js";
import { ResourceLimiter } from "./limits.js";
import { createDshHostAgentPort, type DshSessionService } from "./dsh-host.js";
import { RoomStore } from "./room.js";
import { RoomStreamHub } from "./stream.js";
import { CollabStreamUpgrade } from "./upgrade.js";
import { createCollabHttpServer, type CollabHttpServer } from "./http.js";

export interface DshCollabHostRuntimeOptions {
  roomId: string;
  hostId: string;
  hostSessionId: string;
  title: string;
  hostDisplayName: string;
  sessions: DshSessionService;
  now?: () => number;
  tokenFactory?: () => string;
  port?: number;
  host?: "127.0.0.1" | "0.0.0.0";
}

export interface DshCollabHostRuntime {
  readonly rooms: RoomStore;
  readonly ledger: EventLedger;
  readonly gateway: CollabGateway;
  readonly hub: RoomStreamHub;
  readonly upgrade: CollabStreamUpgrade;
  readonly http: CollabHttpServer;
  dispose(): Promise<void>;
}

/** Build the one Host room runtime used by a DSH process or a local E2E harness. */
export function createDshCollabHostRuntime(options: DshCollabHostRuntimeOptions): DshCollabHostRuntime {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: options.roomId, hostId: options.hostId, hostSessionId: options.hostSessionId, title: options.title, hostDisplayName: options.hostDisplayName, now: options.now?.() });
  const ledger = new EventLedger();
  const invites = new InviteStore(rooms, { tokenFactory: options.tokenFactory });
  const limits = new ResourceLimiter();
  const gateway = new CollabGateway({ rooms, ledger, invites, agent: createDshHostAgentPort({ sessions: options.sessions }), now: options.now, limits, tokenFactory: options.tokenFactory });
  const hub = new RoomStreamHub({ rooms, tokens: gateway.tokens, ledger, now: options.now, limits });
  const upgrade = new CollabStreamUpgrade({ hub, tokens: gateway.tokens, now: options.now });
  const http = createCollabHttpServer({
    gateway,
    host: options.host,
    port: options.port,
    authenticate: ({ headers }) => ({ principalId: headers["x-dsh-principal-id"] }),
  });
  return {
    rooms, ledger, gateway, hub, upgrade, http,
    async dispose(): Promise<void> {
      await http.close();
      await upgrade.close();
      hub.dispose();
    },
  };
}
