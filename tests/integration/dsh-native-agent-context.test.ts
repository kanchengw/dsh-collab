import type { Agent, AgentRegistry } from "@deepseek-ai/dsh-agent";
import { describe, expect, it } from "vitest";
import {
  bindDshNativeAgentContext,
  type DshNativeAgentContextAgent,
  type DshNativeAgentContextMessage,
  type DshNativeAgentContextRegistry,
  type DshNativeAgentSessionEvent,
} from "../../src/dsh-native-agent-context.js";

type SessionListener = (
  session: { id: string },
  event: DshNativeAgentSessionEvent,
) => void;

function proveFixedDshContract(agent: Agent, registry: AgentRegistry): void {
  const compatibleAgent: DshNativeAgentContextAgent = agent;
  const compatibleRegistry: DshNativeAgentContextRegistry = registry;
  void compatibleAgent;
  void compatibleRegistry;
}

void proveFixedDshContract;

class FakeSessionEvents {
  private readonly listeners = new Set<SessionListener>();

  on(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(sessionId: string, event: DshNativeAgentSessionEvent): void {
    for (const listener of this.listeners) listener({ id: sessionId }, event);
  }
}

class FakeNativeAgent {
  readonly inbox = {
    nextStep: [] as DshNativeAgentContextMessage[],
    remove: (messageId: DshNativeAgentContextMessage["id"]): boolean => {
      const index = this.inbox.nextStep.findIndex((message) => message.id === messageId);
      if (index < 0) return false;
      this.cancelAt(index);
      return true;
    },
  };
  readonly session: {
    events: DshNativeAgentSessionEvent[];
    header: { seedLength?: number };
  };
  status: "idle" | "running" = "idle";
  safeToInject = true;
  readonly injected: DshNativeAgentContextMessage[] = [];

  constructor(
    readonly id: string,
    private readonly bus: FakeSessionEvents,
    events: DshNativeAgentSessionEvent[] = [],
  ) {
    this.session = { events: [...events], header: {} };
    this.replay();
  }

  inject(message: DshNativeAgentContextMessage): void {
    this.injected.push(message);
    this.splice({ target: "next-step", start: this.inbox.nextStep.length, inserted: [message] });
  }

  claimNextStep(): void {
    this.splice({
      target: "next-step",
      start: 0,
      removedCount: this.inbox.nextStep.length,
      inserted: [],
    });
  }

  cancelNextStep(): void {
    this.cancelAt(0, this.inbox.nextStep.length);
  }

  private cancelAt(start: number, removedCount = 1): void {
    this.splice({ target: "next-step", start, removedCount, inserted: [], outcome: "canceled" });
  }

  private splice(data: {
    target: "next-step";
    start: number;
    removedCount?: number;
    inserted: DshNativeAgentContextMessage[];
    outcome?: "canceled";
  }): void {
    const event: DshNativeAgentSessionEvent = {
      seq: this.session.events.length,
      type: "agent/inbox/spliced",
      data,
    };
    this.session.events.push(event);
    this.bus.emit(this.id, event);
    this.inbox.nextStep.splice(data.start, data.removedCount ?? 0, ...data.inserted);
  }

  private replay(): void {
    for (const event of this.session.events) {
      if (event.type !== "agent/inbox/spliced") continue;
      const data = event.data as {
        target: "next-step" | "next-turn";
        start: number;
        removedCount?: number;
        inserted: DshNativeAgentContextMessage[];
      };
      if (data.target !== "next-step") continue;
      this.inbox.nextStep.splice(data.start, data.removedCount ?? 0, ...data.inserted);
    }
  }
}

function harness(input: {
  agent?: FakeNativeAgent;
  bus?: FakeSessionEvents;
  sessionId?: string;
} = {}) {
  const bus = input.bus ?? new FakeSessionEvents();
  const sessionId = input.sessionId ?? "session-1";
  const agent = input.agent ?? new FakeNativeAgent(sessionId, bus);
  const agents = new Map<string, FakeNativeAgent>([[sessionId, agent]]);
  const binding = bindDshNativeAgentContext({
    agents: { get: (id) => agents.get(id) },
    onSessionEvent: (listener) => bus.on(listener),
    isSafeToInject: () => agent.safeToInject,
    sessionId,
  });
  return { agent, agents, binding, bus, sessionId };
}

describe("DSH native Agent context bridge", () => {
  it("accepts the fixed DSH public Agent and registry contracts", () => {
    expect(proveFixedDshContract).toBeTypeOf("function");
  });

  it("injects plugin-sourced context into next-step without waking an idle Agent", () => {
    const { agent, binding } = harness();

    const result = binding.deliver({ deliveryId: "room-1:7", text: "Team context" });

    expect(result.state).toBe("injected");
    expect(agent.status).toBe("idle");
    expect(agent.session.events.filter((event) => event.type === "turn/start")).toEqual([]);
    expect(agent.inbox.nextStep).toEqual([{
      id: result.messageId,
      role: "user",
      content: [{ type: "text", text: "Team context" }],
      source: { kind: "plugin", plugin: "dsh-collab" },
    }]);
  });

  it("does not treat public idle status as a safe delivery boundary", () => {
    const { agent, binding } = harness();
    agent.status = "idle";
    agent.safeToInject = false;

    expect(() => binding.deliver({ deliveryId: "room-1:maintenance", text: "Do not inject" }))
      .toThrow("safe");
    expect(agent.injected).toEqual([]);
  });

  it("cancels a still-pending context through the native inbox remove seam", () => {
    const { agent, binding } = harness();
    const first = binding.deliver({ deliveryId: "room-1:7", text: "First" });

    expect(binding.cancel(first.deliveryId)).toBe(true);
    expect(binding.inspect(first.deliveryId)).toBe("missing");
    expect(agent.inbox.nextStep).toEqual([]);
    expect(binding.cancel(first.deliveryId)).toBe(false);
  });

  it("deduplicates a delivery while its stable message is pending", () => {
    const { agent, binding } = harness();

    const first = binding.deliver({ deliveryId: "room-1:7", text: "Team context" });
    const second = binding.deliver({ deliveryId: "room-1:7", text: "Team context" });

    expect(first.state).toBe("injected");
    expect(second).toEqual({ ...first, state: "pending" });
    expect(agent.injected).toHaveLength(1);
  });

  it("acknowledges only a durable next-step claim, not cancellation", () => {
    const { agent, binding } = harness();
    const claimed: unknown[] = [];
    binding.onClaimed((acknowledgement) => claimed.push(acknowledgement));
    const first = binding.deliver({ deliveryId: "room-1:7", text: "First" });

    agent.cancelNextStep();

    expect(claimed).toEqual([]);
    expect(binding.inspect("room-1:7")).toBe("missing");
    const retry = binding.deliver({ deliveryId: "room-1:7", text: "First" });
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.state).toBe("injected");

    agent.claimNextStep();

    expect(claimed).toEqual([{
      deliveryId: "room-1:7",
      messageId: first.messageId,
      sessionEventSeq: 3,
    }]);
    expect(binding.inspect("room-1:7")).toBe("claimed");
    expect(binding.deliver({ deliveryId: "room-1:7", text: "First" })).toEqual({
      deliveryId: "room-1:7",
      messageId: first.messageId,
      state: "claimed",
    });
    expect(agent.injected).toHaveLength(2);
  });

  it("does not acknowledge a pure deletion from the next-turn inbox", () => {
    const { agent, binding, bus, sessionId } = harness();
    const claimed: unknown[] = [];
    binding.onClaimed((acknowledgement) => claimed.push(acknowledgement));
    binding.deliver({ deliveryId: "room-1:7", text: "Team context" });
    const message = agent.injected[0]!;
    agent.cancelNextStep();

    bus.emit(sessionId, {
      seq: 2,
      type: "agent/inbox/spliced",
      data: { target: "next-turn", start: 0, inserted: [message] },
    });
    bus.emit(sessionId, {
      seq: 3,
      type: "agent/inbox/spliced",
      data: { target: "next-turn", start: 0, removedCount: 1, inserted: [] },
    });

    expect(claimed).toEqual([]);
    expect(binding.inspect("room-1:7")).toBe("missing");
  });

  it("replays durable inbox history after restart without reinjecting pending or claimed context", () => {
    const firstBus = new FakeSessionEvents();
    const firstAgent = new FakeNativeAgent("session-1", firstBus);
    const first = harness({ agent: firstAgent, bus: firstBus }).binding;
    const pending = first.deliver({ deliveryId: "room-1:7", text: "Pending" });
    const pendingEvents = [...firstAgent.session.events];

    const resumedPendingBus = new FakeSessionEvents();
    const resumedPendingAgent = new FakeNativeAgent("session-1", resumedPendingBus, pendingEvents);
    const resumedPending = harness({ agent: resumedPendingAgent, bus: resumedPendingBus }).binding;
    expect(resumedPending.deliver({ deliveryId: "room-1:7", text: "Pending" })).toEqual({
      ...pending,
      state: "pending",
    });
    expect(resumedPendingAgent.injected).toHaveLength(0);

    firstAgent.claimNextStep();
    const claimedEvents = [...firstAgent.session.events];
    const resumedClaimedBus = new FakeSessionEvents();
    const resumedClaimedAgent = new FakeNativeAgent("session-1", resumedClaimedBus, claimedEvents);
    const resumedClaimed = harness({ agent: resumedClaimedAgent, bus: resumedClaimedBus }).binding;
    expect(resumedClaimed.deliver({ deliveryId: "room-1:7", text: "Pending" })).toEqual({
      ...pending,
      state: "claimed",
    });
    expect(resumedClaimedAgent.injected).toHaveLength(0);
  });

  it("fails closed when the Session has no live Agent or the exact Agent is replaced", () => {
    const bus = new FakeSessionEvents();
    expect(() => bindDshNativeAgentContext({
      agents: { get: () => undefined },
      isSafeToInject: () => false,
      onSessionEvent: (listener) => bus.on(listener),
      sessionId: "missing",
    })).toThrow("not live");

    const { agents, binding } = harness({ bus });
    agents.set("session-1", new FakeNativeAgent("session-1", bus));

    expect(() => binding.deliver({ deliveryId: "room-1:7", text: "Wrong Agent" }))
      .toThrow("no longer live");
  });

  it("ignores other Sessions and stops injection and acknowledgement after disposal", () => {
    const { agent, binding, bus } = harness();
    const claimed: unknown[] = [];
    binding.onClaimed((acknowledgement) => claimed.push(acknowledgement));
    const delivery = binding.deliver({ deliveryId: "room-1:7", text: "Team context" });
    bus.emit("session-2", {
      seq: 1,
      type: "agent/inbox/spliced",
      data: { target: "next-step", start: 0, removedCount: 1, inserted: [] },
    });
    expect(binding.inspect("room-1:7")).toBe("pending");

    binding.dispose();
    agent.claimNextStep();

    expect(claimed).toEqual([]);
    expect(() => binding.deliver({ deliveryId: "room-1:8", text: "Disposed" }))
      .toThrow("disposed");
    expect(() => binding.inspect(delivery.deliveryId)).toThrow("disposed");
  });
});
