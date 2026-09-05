import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  DshNativeAgentContextAcknowledgement,
  DshNativeAgentContextBinding,
  DshNativeAgentContextState,
} from "../../src/dsh-native-agent-context.js";
import {
  formatRoomContextSnapshot,
  RoomContextDeliveryCoordinator,
  RoomContextDeliveryService,
} from "../../src/room-context-delivery.js";
import type { RoomContextSnapshot } from "../../src/room-context.js";
import { RoomSessionLinkStore } from "../../src/room-session-links.js";

class FakeContextBinding implements DshNativeAgentContextBinding {
  private readonly states = new Map<string, DshNativeAgentContextState>();
  private readonly listeners = new Set<(ack: DshNativeAgentContextAcknowledgement) => void>();
  readonly injections: Array<{ deliveryId: string; text: string }> = [];
  failNextDelivery = false;
  safeToInject = true;
  disposed = false;

  constructor(readonly sessionId: string) {}

  deliver(input: { deliveryId: string; text: string }) {
    if (this.failNextDelivery) {
      this.failNextDelivery = false;
      throw new Error("inject failed");
    }
    const state = this.states.get(input.deliveryId) ?? "missing";
    if (state === "missing") {
      this.injections.push(input);
      this.states.set(input.deliveryId, "pending");
      return { ...input, messageId: `message:${input.deliveryId}`, state: "injected" as const };
    }
    return { ...input, messageId: `message:${input.deliveryId}`, state };
  }

  inspect(deliveryId: string): DshNativeAgentContextState {
    return this.states.get(deliveryId) ?? "missing";
  }

  onClaimed(listener: (ack: DshNativeAgentContextAcknowledgement) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  claim(deliveryId: string): void {
    this.states.set(deliveryId, "claimed");
    const acknowledgement = { deliveryId, messageId: `message:${deliveryId}`, sessionEventSeq: 42 };
    for (const listener of this.listeners) listener(acknowledgement);
  }

  cancel(deliveryId: string): boolean {
    if (this.states.get(deliveryId) !== "pending") return false;
    this.states.set(deliveryId, "missing");
    return true;
  }

  isSafeToInject(): boolean {
    return this.safeToInject;
  }

  restoreClaimed(deliveryId: string): void {
    this.states.set(deliveryId, "claimed");
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

function snapshot(fromSeq = 1, toSeq = 2): RoomContextSnapshot {
  return {
    roomId: "room-1",
    fromSeq,
    toSeq,
    entries: [{ kind: "message", author: "member-2", text: `events ${fromSeq}-${toSeq}` }],
    omittedCount: 0,
  };
}

function harness(input: { active?: boolean; bindingSessionId?: string } = {}) {
  const links = new RoomSessionLinkStore();
  const workspacePath = resolve("room-workspace");
  links.bind({
    roomId: "room-1",
    memberId: "member-1",
    sessionId: "session-1",
    workspacePath,
    sessionCwd: workspacePath,
  });
  if (input.active === false) {
    links.bind({
      roomId: "room-1",
      memberId: "member-1",
      sessionId: "session-2",
      workspacePath,
      sessionCwd: workspacePath,
    });
  }
  const binding = new FakeContextBinding(input.bindingSessionId ?? "session-1");
  const delivery = new RoomContextDeliveryCoordinator({ links, binding });
  return { binding, delivery, links };
}

describe("RoomContextDeliveryCoordinator", () => {
  it("injects a stable plugin context range without advancing the cursor", () => {
    const { binding, delivery, links } = harness();

    const result = delivery.deliver(snapshot());

    expect(result).toEqual({
      deliveryId: "room-context:room-1:1:2",
      fromSeq: 1,
      toSeq: 2,
      state: "injected",
    });
    expect(JSON.parse(binding.injections[0]!.text)).toEqual({
      kind: "dsh-collab.room-context",
      roomId: "room-1",
      fromSeq: 1,
      toSeq: 2,
      entries: [{ kind: "message", author: "member-2", text: "events 1-2" }],
      omittedCount: 0,
    });
    expect(links.getBySession("session-1")?.lastInjectedRoomSeq).toBe(0);
  });

  it("advances the cursor only after the exact durable claim", () => {
    const { binding, delivery, links } = harness();
    const first = delivery.deliver(snapshot());

    binding.claim(first.deliveryId);

    expect(links.getBySession("session-1")?.lastInjectedRoomSeq).toBe(2);
    expect(delivery.deliver(snapshot())).toEqual({ ...first, state: "claimed" });
    expect(binding.injections).toHaveLength(1);
  });

  it("notifies persistence only after the durable cursor advances", () => {
    const { binding, links } = harness();
    const advanced: number[] = [];
    const delivery = new RoomContextDeliveryCoordinator({ links, binding, onCursorAdvanced: (link) => { advanced.push(link.lastInjectedRoomSeq); } });

    const first = delivery.deliver(snapshot());
    expect(advanced).toEqual([]);
    binding.claim(first.deliveryId);

    expect(advanced).toEqual([2]);
  });

  it("deduplicates one pending range and blocks a different overlapping range", () => {
    const { binding, delivery, links } = harness();
    const first = delivery.deliver(snapshot(1, 2));

    expect(delivery.deliver(snapshot(1, 2))).toEqual({ ...first, state: "pending" });
    expect(delivery.deliver(snapshot(1, 3)).state).toBe("injected");
    expect(binding.injections).toHaveLength(2);
    expect(links.getBySession("session-1")?.lastInjectedRoomSeq).toBe(0);

    expect(binding.inspect(first.deliveryId)).toBe("missing");
  });

  it("does not advance the cursor when a packet is claimed but not answered", () => {
    const { binding, delivery, links } = harness();
    const first = delivery.deliver(snapshot());

    binding.claim(first.deliveryId);

    expect(delivery.status(first.deliveryId)).toBe("claimed");
    expect(links.getBySession("session-1")?.lastInjectedRoomSeq).toBe(2);
    expect(delivery.status(first.deliveryId)).not.toBe("answered");
  });

  it("coalesces only while the older packet is still pending", () => {
    const { binding, delivery } = harness();
    const first = delivery.deliver(snapshot(1, 2));

    delivery.deliver(snapshot(1, 3));

    expect(binding.inspect(first.deliveryId)).toBe("missing");
    expect(binding.injections.map(({ deliveryId }) => deliveryId)).toEqual([
      "room-context:room-1:1:2",
      "room-context:room-1:1:3",
    ]);
  });

  it("fails closed when the native bridge has no safe idle gate", () => {
    const { binding, delivery } = harness();
    binding.safeToInject = false;

    expect(() => delivery.deliver(snapshot())).toThrow("safe");
    expect(binding.injections).toEqual([]);
  });

  it("keeps the injected packet structurally bounded", () => {
    const huge = snapshot();
    huge.entries = [{ kind: "message", author: "member-2", text: "x".repeat(40_000) }];

    expect(() => deliverySnapshot(huge)).toThrow("bounded");
  });

  it("rejects a sequence gap or wrong room before calling the native bridge", () => {
    const { binding, delivery } = harness();

    expect(() => delivery.deliver(snapshot(2, 3))).toThrow("contiguous");
    expect(() => delivery.deliver({ ...snapshot(), roomId: "room-2" })).toThrow("room");
    expect(binding.injections).toEqual([]);
  });

  it("does not advance the cursor when native injection fails", () => {
    const { binding, delivery, links } = harness();
    binding.failNextDelivery = true;

    expect(() => delivery.deliver(snapshot())).toThrow("inject failed");

    expect(links.getBySession("session-1")?.lastInjectedRoomSeq).toBe(0);
    expect(delivery.deliver(snapshot()).state).toBe("injected");
  });

  it("accepts a claimed state reconstructed from durable Session history", () => {
    const { binding, delivery, links } = harness();
    binding.restoreClaimed("room-context:room-1:1:2");

    expect(delivery.deliver(snapshot()).state).toBe("claimed");

    expect(links.getBySession("session-1")?.lastInjectedRoomSeq).toBe(2);
    expect(binding.injections).toEqual([]);
  });

  it("rejects inactive links and ignores acknowledgements received after unbind", () => {
    const inactive = harness({ active: false });
    expect(() => inactive.delivery.deliver(snapshot())).toThrow("not active");
    expect(inactive.binding.injections).toEqual([]);

    const active = harness();
    const pending = active.delivery.deliver(snapshot());
    active.links.unbind("session-1");
    active.binding.claim(pending.deliveryId);
    expect(active.links.getBySession("session-1")).toBeUndefined();
    expect(() => active.delivery.deliver(snapshot())).toThrow("not active");
  });

  it("requires the exact Session binding and stops delivery after disposal", () => {
    expect(() => harness({ bindingSessionId: "session-other" })).toThrow("Session");
    const { binding, delivery } = harness();

    delivery.dispose();

    expect(binding.disposed).toBe(true);
    expect(() => delivery.deliver(snapshot())).toThrow("disposed");
  });

  it("fans out one revision using independent per-Session cursors", () => {
    const links = new RoomSessionLinkStore();
    const workspacePath = resolve("room-workspace");
    links.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath, sessionCwd: workspacePath });
    links.bind({ roomId: "room-1", memberId: "member-2", sessionId: "session-2", workspacePath, sessionCwd: workspacePath });
    links.advanceCursor("session-2", 2);
    const bindings = new Map([
      ["session-1", new FakeContextBinding("session-1")],
      ["session-2", new FakeContextBinding("session-2")],
    ]);
    const service = new RoomContextDeliveryService({
      links,
      bind: (sessionId) => bindings.get(sessionId),
    });

    const results = service.deliver({
      roomId: "room-1",
      toSeq: 4,
      createSnapshot: ({ roomId, fromSeq, toSeq }) => ({
        roomId,
        fromSeq,
        toSeq,
        entries: [{ kind: "message", author: "member-1", text: `${fromSeq}-${toSeq}` }],
        omittedCount: 0,
      }),
    });

    expect(results.map(({ deliveryId }) => deliveryId)).toEqual([
      "room-context:room-1:1:4",
      "room-context:room-1:3:4",
    ]);
    expect(JSON.parse(bindings.get("session-1")!.injections[0]!.text).fromSeq).toBe(1);
    expect(JSON.parse(bindings.get("session-2")!.injections[0]!.text).fromSeq).toBe(3);
    expect(links.getBySession("session-1")?.lastInjectedRoomSeq).toBe(0);
    expect(links.getBySession("session-2")?.lastInjectedRoomSeq).toBe(2);
  });
});

function deliverySnapshot(value: RoomContextSnapshot): string {
  // This indirection makes the RED expectation compile before the U10 export exists.
  return (formatRoomContextSnapshot as (snapshot: RoomContextSnapshot) => string)(value);
}
