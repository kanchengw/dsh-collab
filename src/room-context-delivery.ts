import { CollabError, invalidInput } from "./errors.js";
import type {
  DshNativeAgentContextBinding,
  DshNativeAgentContextObservation,
} from "./dsh-native-agent-context.js";
import type { RoomContextForAgent } from "./room-context.js";
import { RoomSessionLinkStore } from "./room-session-links.js";
import type { RoomSessionLink } from "./room-session-links.js";

const MAX_ROOM_CONTEXT_PACKET_BYTES = 32 * 1024;

export interface RoomContextDeliveryResult {
  deliveryId: string;
  fromSeq: number;
  toSeq: number;
  state: "injected" | "pending" | "claimed";
}

export type RoomContextDeliveryObservation = DshNativeAgentContextObservation;

interface PendingDelivery {
  deliveryId: string;
  roomId: string;
  fromSeq: number;
  toSeq: number;
}

function validateRange(snapshot: RoomContextForAgent): void {
  if (!Number.isSafeInteger(snapshot.fromSeq) || snapshot.fromSeq < 1
    || !Number.isSafeInteger(snapshot.toSeq) || snapshot.toSeq < snapshot.fromSeq) {
    throw invalidInput("Room Context range is invalid", {
      fromSeq: snapshot.fromSeq,
      toSeq: snapshot.toSeq,
    });
  }
}

function deliveryId(snapshot: RoomContextForAgent): string {
  return `room-context:${snapshot.roomId}:${snapshot.fromSeq}:${snapshot.toSeq}`;
}

function deliveryResult(
  delivery: PendingDelivery,
  state: RoomContextDeliveryResult["state"],
): RoomContextDeliveryResult {
  return {
    deliveryId: delivery.deliveryId,
    fromSeq: delivery.fromSeq,
    toSeq: delivery.toSeq,
    state,
  };
}

export function formatRoomContextForAgent(snapshot: RoomContextForAgent): string {
  const text = JSON.stringify({ kind: "dsh-collab.room-context", ...snapshot });
  if (new TextEncoder().encode(text).byteLength > MAX_ROOM_CONTEXT_PACKET_BYTES) {
    throw invalidInput("Room Context packet is not structurally bounded", {
      maxBytes: MAX_ROOM_CONTEXT_PACKET_BYTES,
    });
  }
  return text;
}

/** Delivers one contiguous Room Context range to one exact linked native Session. */
export class RoomContextDeliveryCoordinator {
  private pending?: PendingDelivery;
  private readonly answered = new Set<string>();
  private readonly removeClaimedListener: () => void;
  private disposed = false;

  constructor(private readonly input: {
    links: RoomSessionLinkStore;
    binding: DshNativeAgentContextBinding;
    onCursorAdvanced?: (link: RoomSessionLink) => void;
  }) {
    if (!input.links.getBySession(input.binding.sessionId)) {
      throw new CollabError("ACTION_FORBIDDEN", "Native context binding Session has no Room Session Link", {
        sessionId: input.binding.sessionId,
      });
    }
    this.removeClaimedListener = input.binding.onClaimed(({ deliveryId: claimedDeliveryId }) => {
      if (this.disposed || this.pending?.deliveryId !== claimedDeliveryId) return;
      this.acknowledge(this.pending);
    });
  }

  deliver(snapshot: RoomContextForAgent): RoomContextDeliveryResult {
    if (this.disposed) throw new Error("Room Context delivery coordinator is disposed");
    validateRange(snapshot);
    let link = this.activeLink();
    if (snapshot.roomId !== link.roomId) {
      throw new CollabError("ACTION_FORBIDDEN", "Room Context does not belong to the linked room", {
        roomId: snapshot.roomId,
        linkedRoomId: link.roomId,
      });
    }

    this.reconcilePending();
    link = this.activeLink();
    const nextDelivery: PendingDelivery = {
      deliveryId: deliveryId(snapshot),
      roomId: snapshot.roomId,
      fromSeq: snapshot.fromSeq,
      toSeq: snapshot.toSeq,
    };
    if (snapshot.toSeq <= link.lastInjectedRoomSeq) {
      return deliveryResult(nextDelivery, "claimed");
    }
    if (snapshot.fromSeq !== link.lastInjectedRoomSeq + 1) {
      throw invalidInput("Room Context range must be contiguous with the linked Session cursor", {
        expectedFromSeq: link.lastInjectedRoomSeq + 1,
        actualFromSeq: snapshot.fromSeq,
      });
    }
    if (this.pending && this.pending.deliveryId !== nextDelivery.deliveryId) {
      const pendingState = this.input.binding.inspect(this.pending.deliveryId);
      if (pendingState === "pending") {
        if (!this.input.binding.cancel(this.pending.deliveryId)) {
          throw new CollabError("REQUEST_CONFLICT", "Another Room Context range is already pending", {
            pendingDeliveryId: this.pending.deliveryId,
          });
        }
        this.pending = undefined;
      } else {
        this.reconcilePending();
        if (this.pending) {
          throw new CollabError("REQUEST_CONFLICT", "Another Room Context range is already pending", {
            pendingDeliveryId: this.pending.deliveryId,
          });
        }
      }
    }

    this.pending = nextDelivery;
    let result: ReturnType<DshNativeAgentContextBinding["deliver"]>;
    try {
      if (!this.input.binding.isSafeToInject()) {
        throw new CollabError("REQUEST_CONFLICT", "DSH Agent is not at a safe context delivery boundary", {
          sessionId: this.input.binding.sessionId,
        });
      }
      result = this.input.binding.deliver({
        deliveryId: nextDelivery.deliveryId,
        text: formatRoomContextForAgent(snapshot),
      });
    } catch (error) {
      if (this.pending?.deliveryId === nextDelivery.deliveryId) this.pending = undefined;
      throw error;
    }
    if (result.state === "claimed") this.acknowledge(nextDelivery);
    return deliveryResult(nextDelivery, result.state);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = undefined;
    this.answered.clear();
    this.removeClaimedListener();
    this.input.binding.dispose();
  }

  status(deliveryId: string): RoomContextDeliveryObservation {
    if (this.answered.has(deliveryId)) return "answered";
    return this.input.binding.inspect(deliveryId);
  }

  /** Records an observed model answer without changing the durable Room cursor. */
  markAnswered(deliveryId: string): boolean {
    const state = this.input.binding.inspect(deliveryId);
    if (state !== "claimed") return false;
    this.answered.add(deliveryId);
    return true;
  }

  private activeLink() {
    const link = this.input.links.getBySession(this.input.binding.sessionId);
    if (!link?.active) {
      throw new CollabError("ACTION_FORBIDDEN", "Room Session Link is not active", {
        sessionId: this.input.binding.sessionId,
      });
    }
    return link;
  }

  private reconcilePending(): void {
    if (!this.pending) return;
    const state = this.input.binding.inspect(this.pending.deliveryId);
    if (state === "claimed") this.acknowledge(this.pending);
    else if (state === "missing") this.pending = undefined;
  }

  private acknowledge(delivery: PendingDelivery): void {
    if (this.pending?.deliveryId === delivery.deliveryId) this.pending = undefined;
    const link = this.input.links.getBySession(this.input.binding.sessionId);
    if (!link?.active || link.roomId !== delivery.roomId || link.lastInjectedRoomSeq >= delivery.toSeq) return;
    if (link.lastInjectedRoomSeq !== delivery.fromSeq - 1) return;
    const advanced = this.input.links.advanceCursor(link.sessionId, delivery.toSeq);
    this.input.onCursorAdvanced?.(advanced);
  }
}

export interface RoomContextDeliveryServiceInput {
  links: RoomSessionLinkStore;
  bind(sessionId: string): DshNativeAgentContextBinding | undefined;
  onCursorAdvanced?: (link: RoomSessionLink) => void;
}

export interface RoomContextDeliveryBatchInput {
  roomId: string;
  toSeq: number;
  createSnapshot(input: { roomId: string; fromSeq: number; toSeq: number }): RoomContextForAgent;
}

/** Fans one bounded Room Context revision out to each linked native Session. */
export class RoomContextDeliveryService {
  private readonly coordinators = new Map<string, RoomContextDeliveryCoordinator>();

  constructor(private readonly input: RoomContextDeliveryServiceInput) {}

  deliver(input: RoomContextDeliveryBatchInput): RoomContextDeliveryResult[] {
    if (!Number.isSafeInteger(input.toSeq) || input.toSeq < 1) {
      throw invalidInput("Room Context batch revision is invalid", { toSeq: input.toSeq });
    }
    const results: RoomContextDeliveryResult[] = [];
    for (const link of this.input.links.list()) {
      if (!link.active || link.roomId !== input.roomId || link.lastInjectedRoomSeq >= input.toSeq) continue;
      const coordinator = this.coordinator(link.sessionId);
      const snapshot = input.createSnapshot({
        roomId: input.roomId,
        fromSeq: link.lastInjectedRoomSeq + 1,
        toSeq: input.toSeq,
      });
      results.push(coordinator.deliver(snapshot));
    }
    return results;
  }

  dispose(): void {
    for (const coordinator of this.coordinators.values()) coordinator.dispose();
    this.coordinators.clear();
  }

  private coordinator(sessionId: string): RoomContextDeliveryCoordinator {
    const existing = this.coordinators.get(sessionId);
    if (existing) return existing;
    const binding = this.input.bind(sessionId);
    if (!binding) throw new CollabError("ACTION_FORBIDDEN", "Linked DSH Agent is not live", { sessionId });
    const coordinator = new RoomContextDeliveryCoordinator({
      links: this.input.links,
      binding,
      onCursorAdvanced: this.input.onCursorAdvanced,
    });
    this.coordinators.set(sessionId, coordinator);
    return coordinator;
  }
}
