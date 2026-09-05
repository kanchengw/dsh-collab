import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ModelSelection, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import type { DshAssistantStreamPayload } from "./dsh-assistant-stream.js";
import { DshRequestEventTracker } from "./dsh-request-events.js";

export type LocalAgentFrame =
  | { kind: "output"; text: string }
  | { kind: "completed"; text: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };

export interface LocalAgentSessionPort {
  start(input: { cwd?: string; prompt: string; readOnlyRoot?: string }): Promise<{ sessionId: string }>;
  subscribe(sessionId: string, listener: (frame: LocalAgentFrame) => void): () => void;
  cancel(sessionId: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;
}

export interface DshLocalAgentMessage {
  id: string;
  role: "user";
  content: [{ type: "text"; text: string }];
  source: { kind: "user" };
}

export interface DshLocalAgent {
  followup(message: DshLocalAgentMessage): Promise<void> | void;
  cancel(cause: { kind: "user" }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}

export interface DshLocalAgentHandle {
  agent: DshLocalAgent;
  dispose(): Promise<void>;
}

export interface DshLocalAgentSessionEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface DshLocalAgentContext {
  agentDefaultModel: {
    currentSelection(): ModelSelection;
  };
  installModelSelection(agentContext: object, selection: ModelSelectionRef): void;
  agents: {
    create(input: {
      sessionId: string;
      agentOptions: ModelSelection;
      meta?: { cwd?: string };
      setup?: (agentContext: object) => Promise<void> | void;
    }): Promise<DshLocalAgentHandle>;
  };
  agentPresets: {
    mount(agentContext: object): Promise<unknown>;
  };
  on(
    event: "session/event",
    listener: (session: { id: string }, event: DshLocalAgentSessionEvent) => void,
  ): () => void;
  on(
    event: "agent/assistant-stream",
    listener: (payload: DshAssistantStreamPayload<object>) => void,
  ): () => void;
}

interface DshLocalAgentToolContext {
  tools?: {
    restrict(filter: { allow?: string[]; deny?: string[] }): () => void;
    guard(check: (exec: { name: string; arguments: unknown }) => string | undefined): () => void;
  };
}

interface LocalSession {
  acceptingOutput: boolean;
  handle: DshLocalAgentHandle;
  listeners: Set<(frame: LocalAgentFrame) => void>;
  messageId: string;
  tracker: DshRequestEventTracker;
  committedOutput: string;
  output: string;
  removeEvents: () => void;
  terminal: boolean;
  terminalFrame?: Exclude<LocalAgentFrame, { kind: "output" }>;
  attempt?: { id: string; text: string };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readOnlyWorkspaceGuard(root: string, exec: { name: string; arguments: unknown }): string | undefined {
  if (exec.name !== "read") return "Local review workspaces are read-only";
  const filePath = record(exec.arguments)?.file_path;
  if (typeof filePath !== "string" || filePath.trim() === "") return "Local review reads require a workspace path";
  const contained = relative(resolve(root), resolve(root, filePath));
  return contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)
    ? "Local review cannot read outside its snapshot workspace"
    : undefined;
}

function userMessage(prompt: string): DshLocalAgentMessage {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: prompt }],
    source: { kind: "user" },
  };
}

/** Adapt DSH's public Agent registry, preset, and session-event services to local SideTasks. */
export function createDshLocalAgentSessionPort(
  context: DshLocalAgentContext,
  options: { sessionId?: () => string } = {},
): LocalAgentSessionPort {
  const sessions = new Map<string, LocalSession>();
  const nextSessionId = options.sessionId ?? (() => `dsh-collab-sidecar-${randomUUID()}`);

  const requireSession = (sessionId: string): LocalSession => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown local Agent session: ${sessionId}`);
    return session;
  };
  const append = (session: LocalSession, frame: LocalAgentFrame): void => {
    if (frame.kind !== "output") session.terminalFrame = frame;
    for (const listener of session.listeners) listener(frame);
  };

  return {
    async start(input) {
      const sessionId = nextSessionId();
      if (sessions.has(sessionId)) throw new Error(`Local Agent session already exists: ${sessionId}`);
      const selection = context.agentDefaultModel.currentSelection();
      const handle = await context.agents.create({
        sessionId,
        agentOptions: selection,
        ...(input.cwd === undefined ? {} : { meta: { cwd: input.cwd } }),
        setup: async (agentContext) => {
          context.installModelSelection(agentContext, { current: selection, assembled: undefined });
          await context.agentPresets.mount(agentContext);
          if (input.readOnlyRoot === undefined) return;
          const tools = (agentContext as DshLocalAgentToolContext).tools;
          if (!tools) throw new Error("Local review read-only tool policy is unavailable");
          tools.restrict({ allow: ["read"] });
          tools.guard((exec) => readOnlyWorkspaceGuard(input.readOnlyRoot!, exec));
        },
      });
      const message = userMessage(input.prompt);
      const session: LocalSession = {
        acceptingOutput: true,
        handle,
        listeners: new Set(),
        messageId: message.id,
        tracker: new DshRequestEventTracker(message.id),
        committedOutput: "",
        output: "",
        removeEvents: () => {},
        terminal: false,
      };
      sessions.set(sessionId, session);
      const removeSessionEvents = context.on("session/event", (subject, event) => {
        if (subject.id !== sessionId || session.terminal) return;
        session.tracker.apply(event);
        if (!session.tracker.isTerminal || !session.acceptingOutput) return;
        session.terminal = true;
        const result = session.tracker.result("Local Agent");
        if (session.tracker.terminalKind === "aborted" || session.tracker.terminalKind === "canceled") append(session, { kind: "cancelled" });
        else if (result?.error) append(session, { kind: "failed", error: result.error });
        else append(session, { kind: "completed", text: result?.text ?? session.output });
      });
      const removeAssistantStream = context.on("agent/assistant-stream", ({ agent, frame }) => {
        if (agent !== session.handle.agent || !session.tracker.started || !session.acceptingOutput || session.terminal) return;
        if (frame.type === "start") {
          session.attempt = { id: frame.attemptId, text: "" };
          return;
        }
        if (session.attempt?.id !== frame.attemptId) return;
        if (frame.type === "chunk") {
          if (frame.chunk.type !== "text-delta" || typeof frame.chunk.text !== "string") return;
          session.attempt.text += frame.chunk.text;
          const separator = session.committedOutput !== "" && session.attempt.text !== "" ? "\n\n" : "";
          session.output = session.committedOutput + separator + session.attempt.text;
          append(session, { kind: "output", text: session.output });
          return;
        }
        if (frame.outcome.kind === "committed" && frame.outcome.eventType === "assistant/message") {
          if (session.attempt.text !== "") {
            session.committedOutput += (session.committedOutput === "" ? "" : "\n\n") + session.attempt.text;
          }
          session.output = session.committedOutput;
        } else if (session.attempt.text !== "") {
          session.output = session.committedOutput;
          append(session, { kind: "output", text: session.output });
        }
        session.attempt = undefined;
      });
      session.removeEvents = () => {
        removeSessionEvents();
        removeAssistantStream();
      };
      try {
        await handle.agent.followup(message);
        return { sessionId };
      } catch (error) {
        sessions.delete(sessionId);
        session.removeEvents();
        await handle.dispose();
        throw error;
      }
    },
    subscribe(sessionId, listener) {
      const session = requireSession(sessionId);
      if (session.output !== "") listener({ kind: "output", text: session.output });
      if (session.terminalFrame) listener(session.terminalFrame);
      if (!session.terminal) session.listeners.add(listener);
      return () => { session.listeners.delete(listener); };
    },
    async cancel(sessionId) {
      const session = requireSession(sessionId);
      if (session.terminal) return;
      session.acceptingOutput = false;
      session.handle.agent.cancel({ kind: "user" }, { keepInbox: false });
      await session.handle.agent.whenIdle();
      if (session.terminal) return;
      session.terminal = true;
      append(session, { kind: "cancelled" });
    },
    async dispose(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      session.acceptingOutput = false;
      session.terminal = true;
      session.removeEvents();
      session.listeners.clear();
      await session.handle.dispose();
    },
  };
}
