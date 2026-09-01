import { CollabError, invalidInput } from "./errors.js";
import type { DshNativeAgentContextBinding } from "./dsh-native-agent-context.js";
import type { RoomContextSnapshot } from "./room-context.js";
import { RoomSessionLinkStore } from "./room-session-links.js";
import type { RoomSessionLink } from "./room-session-links.js";

export interface RoomContextDeliveryResult {
  deliveryId: string;
  fromSeq: number;
  toSeq: number;
  state: "injected" | "pending" | "claimed";
}

interface PendingDelivery {
  deliveryId: string;
  roomId: string;
  fromSeq: number;
  toSeq: number;
}

function validateRange(snapshot: RoomContextSnapshot): void {
  if (!Number.isSafeInteger(snapshot.fromSeq) || snapshot.fromSeq < 1
    || !Number.isSafeInteger(snapshot.toSeq) || snapshot.toSeq < snapshot.fromSeq) {
    throw invalidInput("Room Context range is invalid", {
      fromSeq: snapshot.fromSeq,
      toSeq: snapshot.toSeq,
    });
  }
}

function deliveryId(snapshot: RoomContextSnapshot): string {
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

export function formatRoomContextSnapshot(snapshot: RoomContextSnapshot): string {
  return JSON.stringify({ kind: "dsh-collab.room-context", ...snapshot });
}

/** Delivers one contiguous Room Context range to one exact linked native Session. */
export class RoomContextDeliveryCoordinator {
  private pending?: PendingDelivery;
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

  deliver(snapshot: RoomContextSnapshot): RoomContextDeliveryResult {
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
      throw new CollabError("REQUEST_CONFLICT", "Another Room Context range is already pending", {
        pendingDeliveryId: this.pending.deliveryId,
      });
    }

    this.pending = nextDelivery;
    let result: ReturnType<DshNativeAgentContextBinding["deliver"]>;
    try {
      result = this.input.binding.deliver({
        deliveryId: nextDelivery.deliveryId,
        text: formatRoomContextSnapshot(snapshot),
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
    this.removeClaimedListener();
    this.input.binding.dispose();
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
