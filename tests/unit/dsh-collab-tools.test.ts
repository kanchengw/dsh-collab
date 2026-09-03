import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bindCollabPublishUpdateTool,
  type DshCollabScopedAgent,
  type DshCollabToolDefinition,
  type PublishWorkUpdateRequest,
  type WorkUpdatePublisher,
} from "../../src/dsh-collab-tools.js";
import { RoomProjectStore } from "../../src/room-projects.js";
import type { WorkUpdate } from "../../src/types.js";

function update(overrides: Partial<WorkUpdate> = {}): WorkUpdate {
  return {
    updateId: "a".repeat(64),
    roomId: "room-1",
    authorId: "member-1",
    sourceSessionId: "session-1",
    summary: "Implemented recovery.",
    filePaths: ["src/recovery.ts"],
    createdAt: 100,
    ...overrides,
  };
}

function roomProjects(): RoomProjectStore {
  const projects = new RoomProjectStore();
  const workspacePath = resolve("workspace");
  projects.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas", workspacePath });
  return projects;
}

function agent(id = "session-1") {
  let definition: DshCollabToolDefinition | undefined;
  let preExecute: ((execution: { name: string }, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
  const unregister = vi.fn();
  const removeGate = vi.fn();
  const value: DshCollabScopedAgent = {
    id,
    session: { header: { cwd: resolve(id === "session-1" ? "workspace" : "private") } },
    ctx: {
      tools: {
        register: vi.fn((nextDefinition) => {
          definition = nextDefinition;
          return unregister;
        }),
      },
      on: vi.fn((_event, listener) => {
        preExecute = listener;
        return removeGate;
      }),
    },
  };
  return { value, definition: () => definition, preExecute: () => preExecute, unregister, removeGate };
}

function execute(definition: DshCollabToolDefinition, args: unknown, callId = "call-1") {
  return definition.execute(args, { callId, signal: new AbortController().signal });
}

describe("Room Project collab_publish_update tool", () => {
  it("registers only on the exact Room Project Agent scope and asks through native DSH approval", async () => {
    const roomSession = agent();
    const other = agent("session-2");
    const agents = new Map([["session-1", roomSession.value], ["session-2", other.value]]);
    const publisher: WorkUpdatePublisher = { publish: vi.fn(async () => update()) };

    bindCollabPublishUpdateTool({ agents, projects: roomProjects(), sessionId: "session-1", publisher });

    expect(roomSession.value.ctx.tools.register).toHaveBeenCalledOnce();
    expect(other.value.ctx.tools.register).not.toHaveBeenCalled();
    expect(roomSession.definition()?.name).toBe("collab_publish_update");
    expect(roomSession.definition()?.parameters).toMatchObject({ additionalProperties: false });
    expect(roomSession.definition()?.parameters.properties).not.toHaveProperty("roomId");
    expect(roomSession.definition()?.parameters.properties).not.toHaveProperty("sourceSessionId");
    expect(roomSession.definition()?.parameters.properties).not.toHaveProperty("clientRequestId");
    await expect(roomSession.preExecute()?.({ name: "collab_publish_update" }, async () => ({ kind: "allow" }))).resolves.toMatchObject({ kind: "ask" });
    await expect(roomSession.preExecute()?.({ name: "read" }, async () => ({ kind: "allow" }))).resolves.toEqual({ kind: "allow" });
  });

  it("derives room, Session, and a stable idempotency key from the binding", async () => {
    const linked = agent();
    const calls: PublishWorkUpdateRequest[] = [];
    const publish = vi.fn(async (input: PublishWorkUpdateRequest) => { calls.push(input); return update(); });
    bindCollabPublishUpdateTool({ agents: new Map([["session-1", linked.value]]), projects: roomProjects(), sessionId: "session-1", publisher: { publish } });
    const definition = linked.definition()!;

    const first = await execute(definition, { summary: "Implemented recovery.", filePaths: ["src/recovery.ts"] });
    const retry = await execute(definition, { summary: "Implemented recovery.", filePaths: ["src/recovery.ts"] });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(calls[0]).toMatchObject({ roomId: "room-1", sourceSessionId: "session-1" });
    expect(calls[1]?.clientRequestId).toBe(calls[0]?.clientRequestId);
    expect(first).toEqual({ updateId: "a".repeat(64), roomId: "room-1", status: "published" });
    expect(retry).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/Implemented recovery|src\/recovery|token|credential/i);
  });

  it("rejects private, identity, and unknown tool arguments before publication", async () => {
    const linked = agent();
    const publish = vi.fn(async () => update());
    bindCollabPublishUpdateTool({ agents: new Map([["session-1", linked.value]]), projects: roomProjects(), sessionId: "session-1", publisher: { publish } });
    const definition = linked.definition()!;

    await expect(execute(definition, { summary: "Safe", filePaths: [], roomId: "room-2" })).rejects.toThrow("arguments");
    await expect(execute(definition, { summary: "Safe", filePaths: [], transcript: "private" })).rejects.toThrow("arguments");
    expect(publish).not.toHaveBeenCalled();
  });

  it("fails closed after leaving the Room Project or exact Agent replacement", async () => {
    const projects = roomProjects();
    const linked = agent();
    const replacement = agent();
    const agents = new Map([["session-1", linked.value]]);
    const publish = vi.fn(async () => update());
    bindCollabPublishUpdateTool({ agents, projects, sessionId: "session-1", publisher: { publish } });
    const definition = linked.definition()!;

    linked.value.session!.header!.cwd = resolve("private");
    await expect(execute(definition, { summary: "Safe", filePaths: [] })).rejects.toThrow("Room Project");
    linked.value.session!.header!.cwd = resolve("workspace");
    agents.set("session-1", replacement.value);
    await expect(execute(definition, { summary: "Safe", filePaths: [] })).rejects.toThrow("live Agent");
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects a publisher response attributed to another room member", async () => {
    const linked = agent();
    bindCollabPublishUpdateTool({
      agents: new Map([["session-1", linked.value]]),
      projects: roomProjects(),
      sessionId: "session-1",
      publisher: { publish: async () => update({ authorId: "member-2" }) },
    });

    await expect(execute(linked.definition()!, { summary: "Safe", filePaths: [] })).rejects.toThrow("identity");
  });

  it("unregisters both the tool and approval gate and propagates publisher failures", async () => {
    const linked = agent();
    const publisher: WorkUpdatePublisher = { publish: vi.fn(async () => { throw new Error("gateway offline"); }) };
    const binding = bindCollabPublishUpdateTool({ agents: new Map([["session-1", linked.value]]), projects: roomProjects(), sessionId: "session-1", publisher });

    await expect(execute(linked.definition()!, { summary: "Safe", filePaths: [] })).rejects.toThrow("gateway offline");
    binding.dispose();
    binding.dispose();
    expect(linked.unregister).toHaveBeenCalledOnce();
    expect(linked.removeGate).toHaveBeenCalledOnce();
  });

  it("refuses to bind a missing Room Project Session", () => {
    const linked = agent();
    const agents = new Map([["session-1", linked.value]]);
    const publisher: WorkUpdatePublisher = { publish: vi.fn(async () => update()) };
    expect(() => bindCollabPublishUpdateTool({ agents, projects: new RoomProjectStore(), sessionId: "session-1", publisher })).toThrow("Room Project");

    expect(() => bindCollabPublishUpdateTool({ agents, projects: roomProjects(), sessionId: "session-2", publisher })).toThrow("live Agent");
    expect(linked.value.ctx.tools.register).not.toHaveBeenCalled();
  });

  it("rolls back tool registration if the approval gate cannot be installed", () => {
    const linked = agent();
    linked.value.ctx.on = vi.fn(() => { throw new Error("scope disposed"); });

    expect(() => bindCollabPublishUpdateTool({
      agents: new Map([["session-1", linked.value]]),
      projects: roomProjects(),
      sessionId: "session-1",
      publisher: { publish: async () => update() },
    })).toThrow("scope disposed");
    expect(linked.unregister).toHaveBeenCalledOnce();
  });
});
