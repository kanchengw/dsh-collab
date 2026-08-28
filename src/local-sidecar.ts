import { randomUUID } from "node:crypto";
import type { SideTask } from "./collaboration-types.js";
import type { LocalAgentFrame, LocalAgentSessionPort } from "./dsh-local-agent.js";

const MAX_PROMPT_LENGTH = 16_000;
const MAX_CONTEXT_MESSAGES = 100;
const MAX_CONTEXT_LENGTH = 256 * 1024;

export interface SideTaskContextMessage {
  eventId: string;
  author: string;
  text: string;
}

export interface LocalSideTaskSnapshot {
  task: SideTask;
  output: string;
  revision: number;
}

export interface StartExplainTaskInput {
  roomId: string;
  requestedBy: string;
  localPrompt: string;
  roomEventSeq: number;
  contextMessages: SideTaskContextMessage[];
}

interface TaskRecord {
  snapshot: LocalSideTaskSnapshot;
  sessionId?: string;
  unsubscribe?: () => void;
  cleanup?: Promise<void>;
  starting?: Promise<void>;
}

function requiredText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maxLength) throw new Error(`${field} is invalid`);
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clone(snapshot: LocalSideTaskSnapshot): LocalSideTaskSnapshot {
  return {
    ...snapshot,
    task: {
      ...snapshot.task,
      context: { ...snapshot.task.context, selectedRoomEventIds: [...snapshot.task.context.selectedRoomEventIds] },
      state: { ...snapshot.task.state },
      publication: { ...snapshot.task.publication },
    },
  };
}

function explainPrompt(context: readonly SideTaskContextMessage[], prompt: string): string {
  const messages = context.map((message) => `[${message.author}]\n${message.text}`).join("\n\n");
  return [
    "You are handling a private explanation task for the local requester.",
    "Use the selected collaboration-room messages only as context. Do not claim to modify the shared workspace.",
    "",
    "<collaboration-context>",
    messages,
    "</collaboration-context>",
    "",
    "<local-request>",
    prompt,
    "</local-request>",
  ].join("\n");
}

/** Owns requester-local SideTasks without entering the room or Main Agent queues. */
export class LocalSidecarService {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly listeners = new Set<(roomId: string) => void>();
  private readonly now: () => number;
  private readonly taskId: () => string;
  private disposed = false;

  constructor(private readonly sessions: LocalAgentSessionPort, options: { now?: () => number; taskId?: () => string } = {}) {
    this.now = options.now ?? Date.now;
    this.taskId = options.taskId ?? randomUUID;
  }

  get(roomId: string): LocalSideTaskSnapshot | undefined {
    const record = this.tasks.get(roomId);
    return record ? clone(record.snapshot) : undefined;
  }

  subscribe(listener: (roomId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async startExplain(input: StartExplainTaskInput): Promise<LocalSideTaskSnapshot> {
    if (this.disposed) throw new Error("Local Sidecar is disposed");
    const roomId = requiredText(input.roomId, "roomId", 256);
    const requestedBy = requiredText(input.requestedBy, "requestedBy", 256);
    const localPrompt = requiredText(input.localPrompt, "localPrompt", MAX_PROMPT_LENGTH);
    if (!Number.isSafeInteger(input.roomEventSeq) || input.roomEventSeq < 0) throw new Error("roomEventSeq is invalid");
    if (!Array.isArray(input.contextMessages) || input.contextMessages.length < 1 || input.contextMessages.length > MAX_CONTEXT_MESSAGES) throw new Error("contextMessages is invalid");
    const contextMessages = input.contextMessages.map((message) => ({
      eventId: requiredText(message.eventId, "eventId", 256),
      author: requiredText(message.author, "author", 256),
      text: requiredText(message.text, "context text", MAX_CONTEXT_LENGTH),
    }));
    if (new Set(contextMessages.map(({ eventId }) => eventId)).size !== contextMessages.length
      || contextMessages.reduce((total, message) => total + message.text.length, 0) > MAX_CONTEXT_LENGTH) {
      throw new Error("contextMessages is invalid");
    }
    const existing = this.tasks.get(roomId);
    if (existing && (existing.snapshot.task.state.status === "queued" || existing.snapshot.task.state.status === "running")) {
      throw new Error("A local SideTask is already running for this room");
    }

    const record: TaskRecord = {
      snapshot: {
        task: {
          taskId: this.taskId(),
          roomId,
          type: "explain",
          localPrompt,
          executor: "requester-local",
          context: {
            roomEventSeq: input.roomEventSeq,
            selectedRoomEventIds: contextMessages.map(({ eventId }) => eventId),
          },
          state: { status: "queued" },
          publication: { status: "private" },
          requestedBy,
          createdAt: this.now(),
        },
        output: "",
        revision: 1,
      },
    };
    this.tasks.set(roomId, record);
    this.publish(roomId);
    try {
      record.starting = (async () => {
        const { sessionId } = await this.sessions.start({ prompt: explainPrompt(contextMessages, localPrompt) });
        record.sessionId = sessionId;
        if (this.disposed) {
          await this.sessions.cancel(sessionId).catch(() => undefined);
          this.finish(record, { status: "cancelled" }, record.snapshot.output);
          await record.cleanup;
          throw new Error("Local Sidecar is disposed");
        }
        this.update(record, { ...record.snapshot.task, state: { status: "running" } }, record.snapshot.output);
        record.unsubscribe = this.sessions.subscribe(sessionId, (frame) => { this.applyFrame(record, frame); });
        if (record.cleanup) await record.cleanup;
      })();
      await record.starting;
      return clone(record.snapshot);
    } catch (error) {
      if (record.snapshot.task.state.status === "queued" || record.snapshot.task.state.status === "running") {
        const failed = { status: "failed", error: errorMessage(error) } as const;
        if (record.sessionId) {
          this.finish(record, failed, record.snapshot.output);
          await record.cleanup;
        } else {
          this.update(record, { ...record.snapshot.task, state: failed }, record.snapshot.output);
        }
      }
      throw error;
    } finally {
      record.starting = undefined;
    }
  }

  async cancel(roomId: string, taskId: string): Promise<LocalSideTaskSnapshot> {
    const record = this.tasks.get(roomId);
    if (!record || record.snapshot.task.taskId !== taskId) throw new Error("Local SideTask was not found");
    if (record.snapshot.task.state.status === "queued" && record.starting) await record.starting.catch(() => undefined);
    if (record.snapshot.task.state.status !== "queued" && record.snapshot.task.state.status !== "running") return clone(record.snapshot);
    if (!record.sessionId) throw new Error("Local SideTask has not started");
    try {
      await this.sessions.cancel(record.sessionId);
    } catch (error) {
      if (!record.cleanup) this.finish(record, { status: "failed", error: `Local Agent cancel failed: ${errorMessage(error)}` }, record.snapshot.output);
      await record.cleanup;
      throw error;
    }
    if (!record.cleanup) this.finish(record, { status: "cancelled" }, record.snapshot.output);
    await record.cleanup;
    return clone(record.snapshot);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.tasks.values()].map(async (record) => {
      await record.starting?.catch(() => undefined);
      const status = record.snapshot.task.state.status;
      if (record.sessionId && (status === "queued" || status === "running")) await this.sessions.cancel(record.sessionId).catch(() => undefined);
      if (record.sessionId && !record.cleanup) this.finish(record, { status: "cancelled" }, record.snapshot.output);
      await record.cleanup;
    }));
    this.tasks.clear();
    this.listeners.clear();
  }

  private applyFrame(record: TaskRecord, frame: LocalAgentFrame): void {
    if (record.cleanup) return;
    if (frame.kind === "output") {
      this.update(record, record.snapshot.task, frame.text);
      return;
    }
    if (frame.kind === "completed") this.finish(record, { status: "completed" }, frame.text);
    else if (frame.kind === "cancelled") this.finish(record, { status: "cancelled" }, record.snapshot.output);
    else this.finish(record, { status: "failed", error: frame.error }, record.snapshot.output);
  }

  private finish(record: TaskRecord, state: SideTask["state"], output: string): void {
    if (record.cleanup) return;
    this.update(record, { ...record.snapshot.task, state }, output);
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    record.cleanup = record.sessionId
      ? this.sessions.dispose(record.sessionId).catch((error: unknown) => {
          if (record.snapshot.task.state.status !== "failed") {
            this.update(record, {
              ...record.snapshot.task,
              state: { status: "failed", error: `Local Agent cleanup failed: ${errorMessage(error)}` },
            }, record.snapshot.output);
          }
        })
      : Promise.resolve();
  }

  private update(record: TaskRecord, task: SideTask, output: string): void {
    record.snapshot = { task, output, revision: record.snapshot.revision + 1 };
    this.publish(task.roomId);
  }

  private publish(roomId: string): void {
    for (const listener of this.listeners) listener(roomId);
  }
}
