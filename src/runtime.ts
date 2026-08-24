import { ApprovalStore, type ApprovalStoreSnapshot } from "./approvals.js";
import { AgentDispatcher } from "./dispatcher.js";
import { EventLedger } from "./events.js";
import { CollabError } from "./errors.js";
import { RoomStore } from "./room.js";
import type {
  DispatcherSnapshot,
  HostAgentPort,
  LedgerSnapshot,
  RoomStoreSnapshot,
} from "./types.js";

export interface CollabRuntimeSnapshot {
  version: 1;
  rooms: RoomStoreSnapshot;
  ledger: LedgerSnapshot;
  dispatcher: DispatcherSnapshot;
  approvals?: ApprovalStoreSnapshot;
}

export class CollabRuntime {
  readonly rooms: RoomStore;
  readonly ledger: EventLedger;
  readonly dispatcher: AgentDispatcher;
  readonly approvals?: ApprovalStore;

  constructor(input: { rooms: RoomStore; ledger: EventLedger; dispatcher: AgentDispatcher; approvals?: ApprovalStore }) {
    this.rooms = input.rooms;
    this.ledger = input.ledger;
    this.dispatcher = input.dispatcher;
    this.approvals = input.approvals;
  }

  snapshot(): CollabRuntimeSnapshot {
    const snapshot: CollabRuntimeSnapshot = {
      version: 1,
      rooms: this.rooms.snapshot(),
      ledger: this.ledger.snapshot(),
      dispatcher: this.dispatcher.snapshot(),
    };
    if (this.approvals) snapshot.approvals = this.approvals.snapshot();
    return snapshot;
  }

  static fromSnapshot(input: { snapshot: CollabRuntimeSnapshot; agent: HostAgentPort; answerer?: object }): CollabRuntime {
    if (!input.snapshot || input.snapshot.version !== 1) throw new CollabError("SNAPSHOT_INVALID", "unsupported runtime snapshot");
    const rooms = RoomStore.fromSnapshot(input.snapshot.rooms);
    const ledger = EventLedger.fromSnapshot(input.snapshot.ledger);
    const dispatcher = AgentDispatcher.fromSnapshot({ rooms, ledger, agent: input.agent, snapshot: input.snapshot.dispatcher });
    const approvals = input.snapshot.approvals
      ? ApprovalStore.fromSnapshot({ rooms, ledger, answerer: input.answerer, snapshot: input.snapshot.approvals })
      : undefined;
    return new CollabRuntime({ rooms, ledger, dispatcher, approvals });
  }
}
