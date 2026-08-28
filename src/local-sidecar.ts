import { randomUUID } from "node:crypto";
import type { ReviewFindingCreateInput, ReviewPointFile, SideTask } from "./collaboration-types.js";
import type { LocalAgentFrame, LocalAgentSessionPort } from "./dsh-local-agent.js";
import { isSafeWorkspaceSnapshotPath } from "./workspace-snapshot-store.js";

const MAX_PROMPT_LENGTH = 16_000;
const MAX_CONTEXT_MESSAGES = 100;
const MAX_CONTEXT_LENGTH = 256 * 1024;
const MAX_REVIEW_FINDINGS = 100;

export interface SideTaskContextMessage {
  eventId: string;
  author: string;
  text: string;
}

export interface LocalSideTaskSnapshot {
  task: SideTask;
  output: string;
  findings?: ReviewFindingCreateInput[];
  revision: number;
}

export interface LocalSidecarServiceSnapshot {
  version: 1;
  tasks: LocalSideTaskSnapshot[];
}

export interface LocalSnapshotAccess {
  gatewayEndpoint: string;
  roomToken: string;
}

export interface LocalSidecarWorkspacePort {
  prepare(input: {
    roomId: string;
    requestedBy: string;
    roomEventSeq: number;
    snapshotId?: string;
    remote?: LocalSnapshotAccess;
  }): Promise<{ root: string; snapshotId: string; dispose(): Promise<void> }>;
}

export interface StartExplainTaskInput {
  roomId: string;
  requestedBy: string;
  localPrompt: string;
  roomEventSeq: number;
  contextMessages: SideTaskContextMessage[];
  includeWorkspace?: boolean;
  remote?: LocalSnapshotAccess;
}

export interface StartReviewTaskInput {
  roomId: string;
  requestedBy: string;
  localPrompt: string;
  roomEventSeq: number;
  contextMessages: SideTaskContextMessage[];
  reviewPoint: {
    reviewPointId: string;
    title: string;
    focus?: string;
    workspaceSnapshotId: string;
    files: Array<Pick<ReviewPointFile, "path" | "status">>;
  };
  remote?: LocalSnapshotAccess;
}

interface TaskRecord {
  snapshot: LocalSideTaskSnapshot;
  sessionId?: string;
  unsubscribe?: () => void;
  cleanup?: Promise<void>;
  starting?: Promise<void>;
  workspace?: { dispose(): Promise<void> };
  parseCompleted?: (text: string) => { output: string; findings?: ReviewFindingCreateInput[] };
}

interface ValidatedContext {
  roomId: string;
  requestedBy: string;
  localPrompt: string;
  roomEventSeq: number;
  messages: SideTaskContextMessage[];
}

interface PreparedTask {
  prompt: string;
  workspace?: { root: string; snapshotId: string; dispose(): Promise<void> };
}

function requiredText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} is invalid`);
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
    ...(snapshot.findings ? { findings: structuredClone(snapshot.findings) } : {}),
  };
}

function contextPrompt(context: readonly SideTaskContextMessage[]): string {
  return context.map((message) => `[${message.author}]\n${message.text}`).join("\n\n");
}

function explainPrompt(context: readonly SideTaskContextMessage[], prompt: string, codeAware: boolean): string {
  return [
    "You are handling a private explanation task for the local requester.",
    codeAware
      ? "Use the read-only snapshot workspace when code is relevant. Do not claim to modify the shared workspace."
      : "Use the selected collaboration-room messages only as context. Do not claim to modify the shared workspace.",
    "",
    "<collaboration-context>",
    contextPrompt(context),
    "</collaboration-context>",
    "",
    "<local-request>",
    prompt,
    "</local-request>",
  ].join("\n");
}

function reviewPrompt(input: StartReviewTaskInput, context: readonly SideTaskContextMessage[], localPrompt: string): string {
  return [
    "You are performing a private code review in a fixed read-only snapshot workspace.",
    "Read only files inside the workspace. Do not edit files, run shell commands, or claim to modify the Host workspace.",
    "Return only one JSON object with this shape:",
    '{"summary":"short summary","findings":[{"severity":"critical|high|medium|low|note","location":{"kind":"general"}|{"kind":"file","path":"path"}|{"kind":"line","path":"path","line":1},"body":"actionable finding"}]}',
    "Use an empty findings array when no issue is found. Do not wrap the JSON in Markdown fences.",
    "",
    `<review-point title=${JSON.stringify(input.reviewPoint.title)}>`,
    ...(input.reviewPoint.focus ? [`Focus: ${input.reviewPoint.focus}`] : []),
    `Files:\n${input.reviewPoint.files.map((file) => `- ${file.path} (${file.status})`).join("\n")}`,
    "</review-point>",
    "",
    "<collaboration-context>",
    contextPrompt(context),
    "</collaboration-context>",
    "",
    "<local-request>",
    localPrompt,
    "</local-request>",
  ].join("\n");
}

function validateContext(input: StartExplainTaskInput | StartReviewTaskInput, allowEmpty = false): ValidatedContext {
  const roomId = requiredText(input.roomId, "roomId", 256);
  const requestedBy = requiredText(input.requestedBy, "requestedBy", 256);
  const localPrompt = requiredText(input.localPrompt, "localPrompt", MAX_PROMPT_LENGTH);
  if (!Number.isSafeInteger(input.roomEventSeq) || input.roomEventSeq < 0) throw new Error("roomEventSeq is invalid");
  if (!Array.isArray(input.contextMessages) || (!allowEmpty && input.contextMessages.length < 1) || input.contextMessages.length > MAX_CONTEXT_MESSAGES) throw new Error("contextMessages is invalid");
  const messages = input.contextMessages.map((message) => ({
    eventId: requiredText(message.eventId, "eventId", 256),
    author: requiredText(message.author, "author", 256),
    text: requiredText(message.text, "context text", MAX_CONTEXT_LENGTH),
  }));
  if (new Set(messages.map(({ eventId }) => eventId)).size !== messages.length
    || messages.reduce((total, message) => total + message.text.length, 0) > MAX_CONTEXT_LENGTH) {
    throw new Error("contextMessages is invalid");
  }
  return { roomId, requestedBy, localPrompt, roomEventSeq: input.roomEventSeq, messages };
}

function reviewFinding(value: unknown, allowedPaths: ReadonlySet<string>): ReviewFindingCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local review result is not structured findings");
  const finding = value as Partial<ReviewFindingCreateInput>;
  if (!finding.severity || !["critical", "high", "medium", "low", "note"].includes(finding.severity)
    || typeof finding.body !== "string" || finding.body.trim() === "" || finding.body.length > 4_000
    || !finding.location || typeof finding.location !== "object") {
    throw new Error("Local review result is not structured findings");
  }
  const location = finding.location;
  if (location.kind === "general") return { severity: finding.severity, location: { kind: "general" }, body: finding.body.trim() };
  if ((location.kind !== "file" && location.kind !== "line") || typeof location.path !== "string" || !allowedPaths.has(location.path)) {
    throw new Error("Local review result is not structured findings");
  }
  if (location.kind === "line") {
    if (!Number.isSafeInteger(location.line) || location.line < 1) throw new Error("Local review result is not structured findings");
    return { severity: finding.severity, location: { kind: "line", path: location.path, line: location.line }, body: finding.body.trim() };
  }
  return { severity: finding.severity, location: { kind: "file", path: location.path }, body: finding.body.trim() };
}

function parseReviewResult(text: string, allowedPaths: ReadonlySet<string>): { output: string; findings: ReviewFindingCreateInput[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Local review result is not structured findings", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local review result is not structured findings");
  const result = value as { summary?: unknown; findings?: unknown };
  if (typeof result.summary !== "string" || result.summary.trim() === "" || result.summary.length > 16_000
    || !Array.isArray(result.findings) || result.findings.length > MAX_REVIEW_FINDINGS) {
    throw new Error("Local review result is not structured findings");
  }
  return { output: result.summary.trim(), findings: result.findings.map((finding) => reviewFinding(finding, allowedPaths)) };
}

function terminal(state: SideTask["state"]): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "cancelled";
}

function containsSensitiveSource(value: object): boolean {
  return ["remote", "gatewayEndpoint", "roomToken", "credential", "source"].some((field) => field in value);
}

function validPublication(value: SideTask["publication"]): boolean {
  return value?.status === "private" || (value?.status === "published"
    && /^[a-f0-9]{64}$/.test(value.publicationId)
    && Number.isSafeInteger(value.publishedAt) && value.publishedAt >= 0);
}

function restoredTask(value: LocalSideTaskSnapshot): LocalSideTaskSnapshot {
  const task = value?.task;
  if (!value || containsSensitiveSource(value) || !task || containsSensitiveSource(task)
    || typeof task.taskId !== "string" || task.taskId.trim() === "" || typeof task.roomId !== "string" || task.roomId.trim() === ""
    || (task.type !== "explain" && task.type !== "review") || task.executor !== "requester-local"
    || typeof task.localPrompt !== "string" || task.localPrompt.trim() === "" || typeof task.requestedBy !== "string" || task.requestedBy.trim() === ""
    || !Number.isSafeInteger(task.createdAt) || task.createdAt < 0 || !task.state || !terminal(task.state) || !validPublication(task.publication)
    || !task.context || containsSensitiveSource(task.context)
    || !Number.isSafeInteger(task.context.roomEventSeq) || task.context.roomEventSeq < 0
    || !Array.isArray(task.context.selectedRoomEventIds) || (task.type === "explain" && task.context.selectedRoomEventIds.length < 1)
    || task.context.selectedRoomEventIds.some((eventId) => typeof eventId !== "string" || eventId.trim() === "")
    || typeof value.output !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (task.publication.status === "published" && (task.type !== "review" || task.state.status !== "completed" || !Array.isArray(value.findings) || value.findings.length < 1))
    || (task.type === "review" && (!/^[a-f0-9]{64}$/.test(String(task.context.reviewPointId))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(task.context.workspaceSnapshotId))))
    || (task.type === "review" && task.state.status === "completed" && !Array.isArray(value.findings))) {
    throw new Error("Local SideTask snapshot is malformed");
  }
  const snapshot = clone(value);
  if (snapshot.findings !== undefined) {
    if (task.type !== "review" || !Array.isArray(snapshot.findings)) throw new Error("Local SideTask snapshot is malformed");
    const allowed = new Set(snapshot.findings.flatMap((finding) => finding.location.kind === "general" ? [] : [finding.location.path]));
    snapshot.findings = snapshot.findings.map((finding) => reviewFinding(finding, allowed));
  }
  return snapshot;
}

/** Owns requester-local SideTasks without entering the room or Main Agent queues. */
export class LocalSidecarService {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly listeners = new Set<(roomId: string) => void>();
  private readonly now: () => number;
  private readonly taskId: () => string;
  private readonly workspace?: LocalSidecarWorkspacePort;
  private disposed = false;

  constructor(private readonly sessions: LocalAgentSessionPort, options: {
    now?: () => number;
    taskId?: () => string;
    workspace?: LocalSidecarWorkspacePort;
    snapshot?: LocalSidecarServiceSnapshot;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.taskId = options.taskId ?? randomUUID;
    this.workspace = options.workspace;
    if (options.snapshot) {
      if (options.snapshot.version !== 1 || !Array.isArray(options.snapshot.tasks)) throw new Error("Local SideTask snapshot is malformed");
      for (const snapshot of options.snapshot.tasks) {
        const restored = restoredTask(snapshot);
        if (this.tasks.has(restored.task.roomId)) throw new Error("Local SideTask snapshot contains duplicate rooms");
        this.tasks.set(restored.task.roomId, { snapshot: restored });
      }
    }
  }

  get(roomId: string): LocalSideTaskSnapshot | undefined {
    const record = this.tasks.get(roomId);
    return record ? clone(record.snapshot) : undefined;
  }

  snapshot(): LocalSidecarServiceSnapshot {
    return {
      version: 1,
      tasks: [...this.tasks.values()].filter((record) => terminal(record.snapshot.task.state)).map((record) => clone(record.snapshot)),
    };
  }

  subscribe(listener: (roomId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async startExplain(input: StartExplainTaskInput): Promise<LocalSideTaskSnapshot> {
    const context = validateContext(input);
    return await this.startTask({
      context,
      type: "explain",
      prepare: () => {
        if (input.includeWorkspace !== true) return { prompt: explainPrompt(context.messages, context.localPrompt, false) };
        return this.prepareWorkspace({ ...context, remote: input.remote }).then((workspace) => ({
          prompt: explainPrompt(context.messages, context.localPrompt, true),
          workspace,
        }));
      },
    });
  }

  async startReview(input: StartReviewTaskInput): Promise<LocalSideTaskSnapshot> {
    const context = validateContext(input, true);
    const point = input.reviewPoint;
    if (!point) throw new Error("reviewPoint is invalid");
    requiredText(point.title, "reviewPoint.title", 120);
    if (!/^[a-f0-9]{64}$/.test(point.reviewPointId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(point.workspaceSnapshotId)
      || !Array.isArray(point.files) || point.files.length < 1
      || point.files.some((file) => !file || typeof file.path !== "string" || !isSafeWorkspaceSnapshotPath(file.path)
        || !["added", "modified", "deleted", "renamed"].includes(file.status))) {
      throw new Error("reviewPoint is invalid");
    }
    const allowedPaths = new Set(point.files.map((file) => file.path));
    return await this.startTask({
      context,
      type: "review",
      reviewPointId: point.reviewPointId,
      workspaceSnapshotId: point.workspaceSnapshotId,
      parseCompleted: (text) => parseReviewResult(text, allowedPaths),
      prepare: async () => ({
        prompt: reviewPrompt(input, context.messages, context.localPrompt),
        workspace: await this.prepareWorkspace({ ...context, snapshotId: point.workspaceSnapshotId, remote: input.remote }),
      }),
    });
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

  markPublished(roomId: string, taskId: string, publicationId: string, publishedAt: number): LocalSideTaskSnapshot {
    const record = this.tasks.get(roomId);
    if (!record || record.snapshot.task.taskId !== taskId) throw new Error("Local SideTask was not found");
    const task = record.snapshot.task;
    if (task.type !== "review" || task.state.status !== "completed" || !record.snapshot.findings?.length) {
      throw new Error("Only a completed local Review with findings can be published");
    }
    if (!/^[a-f0-9]{64}$/.test(publicationId) || !Number.isSafeInteger(publishedAt) || publishedAt < 0) {
      throw new Error("Local SideTask publication is invalid");
    }
    if (task.publication.status === "published") {
      if (task.publication.publicationId !== publicationId) throw new Error("Local SideTask is linked to a different publication");
      return clone(record.snapshot);
    }
    this.update(record, { ...task, publication: { status: "published", publicationId, publishedAt } }, record.snapshot.output);
    return clone(record.snapshot);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.tasks.values()].map(async (record) => {
      await record.starting?.catch(() => undefined);
      const status = record.snapshot.task.state.status;
      if (record.sessionId && (status === "queued" || status === "running")) await this.sessions.cancel(record.sessionId).catch(() => undefined);
      if ((record.sessionId || record.workspace) && !record.cleanup) this.finish(record, { status: "cancelled" }, record.snapshot.output);
      await record.cleanup;
    }));
    this.tasks.clear();
    this.listeners.clear();
  }

  private async startTask(input: {
    context: ValidatedContext;
    type: "explain" | "review";
    reviewPointId?: string;
    workspaceSnapshotId?: string;
    prepare(): PreparedTask | Promise<PreparedTask>;
    parseCompleted?: (text: string) => { output: string; findings?: ReviewFindingCreateInput[] };
  }): Promise<LocalSideTaskSnapshot> {
    if (this.disposed) throw new Error("Local Sidecar is disposed");
    const existing = this.tasks.get(input.context.roomId);
    if (existing && (existing.snapshot.task.state.status === "queued" || existing.snapshot.task.state.status === "running")) {
      throw new Error("A local SideTask is already running for this room");
    }
    if (existing?.cleanup) {
      await existing.cleanup;
      if (this.disposed) throw new Error("Local Sidecar is disposed");
      const replacement = this.tasks.get(input.context.roomId);
      if (replacement !== existing && replacement && !terminal(replacement.snapshot.task.state)) {
        throw new Error("A local SideTask is already running for this room");
      }
    }
    const record: TaskRecord = {
      snapshot: {
        task: {
          taskId: this.taskId(),
          roomId: input.context.roomId,
          type: input.type,
          localPrompt: input.context.localPrompt,
          executor: "requester-local",
          context: {
            roomEventSeq: input.context.roomEventSeq,
            selectedRoomEventIds: input.context.messages.map(({ eventId }) => eventId),
            ...(input.workspaceSnapshotId ? { workspaceSnapshotId: input.workspaceSnapshotId } : {}),
            ...(input.reviewPointId ? { reviewPointId: input.reviewPointId } : {}),
          },
          state: { status: "queued" },
          publication: { status: "private" },
          requestedBy: input.context.requestedBy,
          createdAt: this.now(),
        },
        output: "",
        revision: 1,
      },
      ...(input.parseCompleted ? { parseCompleted: input.parseCompleted } : {}),
    };
    this.tasks.set(input.context.roomId, record);
    this.publish(input.context.roomId);
    try {
      record.starting = (async () => {
        const preparation = input.prepare();
        const prepared = preparation instanceof Promise ? await preparation : preparation;
        if (prepared.workspace) {
          record.workspace = prepared.workspace;
          if (record.snapshot.task.context.workspaceSnapshotId !== prepared.workspace.snapshotId) {
            this.update(record, {
              ...record.snapshot.task,
              context: { ...record.snapshot.task.context, workspaceSnapshotId: prepared.workspace.snapshotId },
            }, record.snapshot.output);
          }
        }
        if (this.disposed) throw new Error("Local Sidecar is disposed");
        const { sessionId } = await this.sessions.start({
          prompt: prepared.prompt,
          ...(prepared.workspace ? { cwd: prepared.workspace.root, readOnlyRoot: prepared.workspace.root } : {}),
        });
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
        if (record.sessionId || record.workspace) {
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

  private async prepareWorkspace(input: ValidatedContext & { snapshotId?: string; remote?: LocalSnapshotAccess }): Promise<{ root: string; snapshotId: string; dispose(): Promise<void> }> {
    if (!this.workspace) throw new Error("Local Sidecar workspace is unavailable");
    return await this.workspace.prepare({
      roomId: input.roomId,
      requestedBy: input.requestedBy,
      roomEventSeq: input.roomEventSeq,
      ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
      ...(input.remote ? { remote: input.remote } : {}),
    });
  }

  private applyFrame(record: TaskRecord, frame: LocalAgentFrame): void {
    if (record.cleanup) return;
    if (frame.kind === "output") {
      this.update(record, record.snapshot.task, frame.text);
      return;
    }
    if (frame.kind === "completed") {
      try {
        const result = record.parseCompleted?.(frame.text) ?? { output: frame.text };
        this.finish(record, { status: "completed" }, result.output, result.findings);
      } catch (error) {
        this.finish(record, { status: "failed", error: errorMessage(error) }, frame.text);
      }
    } else if (frame.kind === "cancelled") this.finish(record, { status: "cancelled" }, record.snapshot.output);
    else this.finish(record, { status: "failed", error: frame.error }, record.snapshot.output);
  }

  private finish(record: TaskRecord, state: SideTask["state"], output: string, findings?: ReviewFindingCreateInput[]): void {
    if (record.cleanup) return;
    this.update(record, { ...record.snapshot.task, state }, output, findings);
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    record.cleanup = (async () => {
      let sessionCleanupError: unknown;
      let workspaceCleanupError: unknown;
      if (record.sessionId) {
        try { await this.sessions.dispose(record.sessionId); } catch (error) { sessionCleanupError = error; }
      }
      if (record.workspace) {
        try { await record.workspace.dispose(); } catch (error) { workspaceCleanupError = error; }
      }
      const cleanupError = sessionCleanupError ?? workspaceCleanupError;
      if (cleanupError !== undefined && record.snapshot.task.state.status !== "failed") {
        const source = sessionCleanupError !== undefined ? "Local Agent" : "Local workspace";
        this.update(record, {
          ...record.snapshot.task,
          state: { status: "failed", error: `${source} cleanup failed: ${errorMessage(cleanupError)}` },
        }, record.snapshot.output, record.snapshot.findings);
      }
    })();
  }

  private update(record: TaskRecord, task: SideTask, output: string, findings = record.snapshot.findings): void {
    record.snapshot = {
      task,
      output,
      ...(findings ? { findings: structuredClone(findings) } : {}),
      revision: record.snapshot.revision + 1,
    };
    this.publish(task.roomId);
  }

  private publish(roomId: string): void {
    for (const listener of this.listeners) listener(roomId);
  }
}
