import { createHash } from "node:crypto";
import type { ParticipantGatewayTransport } from "./participant.js";
import type { RoomSessionLink, RoomSessionLinkStore } from "./room-session-links.js";
import type { WorkUpdate } from "./types.js";
import { validateWorkUpdate } from "./work-updates.js";

export interface PublishWorkUpdateRequest {
  roomId: string;
  clientRequestId: string;
  sourceSessionId: string;
  summary: string;
  filePaths: string[];
  changeSetId?: string;
  signal?: AbortSignal;
}

export interface WorkUpdatePublisher {
  publish(input: PublishWorkUpdateRequest): Promise<WorkUpdate>;
}

export interface DshCollabToolExecution {
  callId: string;
  signal: AbortSignal;
}

export interface DshCollabToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    additionalProperties: false;
    properties: Record<string, unknown>;
    required: string[];
  };
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): Array<{ type: "text"; text: string }>;
  };
  execute(args: unknown, execution: DshCollabToolExecution): Promise<unknown>;
}

interface DshCollabPreToolExecution {
  name: string;
}

export interface DshCollabScopedAgent {
  id: string;
  ctx: {
    tools: { register(definition: DshCollabToolDefinition): () => void };
    on(
      event: "tools/pre-execute",
      listener: (execution: DshCollabPreToolExecution, next: () => Promise<unknown>) => Promise<unknown>,
    ): () => void;
  };
}

export interface DshCollabToolAgentRegistry {
  get(sessionId: string): DshCollabScopedAgent | undefined;
}

export interface CollabPublishUpdateToolBinding {
  readonly roomId: string;
  readonly sessionId: string;
  dispose(): void;
}

interface PublishUpdateArgs {
  summary: string;
  filePaths: string[];
  changeSetId?: string;
}

function parseArgs(value: unknown): PublishUpdateArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("collab_publish_update arguments are invalid");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["summary", "filePaths", "changeSetId"]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || typeof input.summary !== "string"
    || !Array.isArray(input.filePaths) || input.filePaths.some((path) => typeof path !== "string")
    || (input.changeSetId !== undefined && typeof input.changeSetId !== "string")) {
    throw new Error("collab_publish_update arguments are invalid");
  }
  return {
    summary: input.summary,
    filePaths: [...input.filePaths] as string[],
    ...(input.changeSetId === undefined ? {} : { changeSetId: input.changeSetId }),
  };
}

function idempotencyKey(sessionId: string, callId: string): string {
  return createHash("sha256").update(`${sessionId}\0${callId}`, "utf8").digest("hex");
}

function currentLink(links: RoomSessionLinkStore, expected: RoomSessionLink): RoomSessionLink {
  const current = links.getBySession(expected.sessionId);
  if (!current) throw new Error("Session is no longer linked to this Collab room");
  if (!current.active || current.roomId !== expected.roomId || current.memberId !== expected.memberId) {
    throw new Error("Session does not have the active Collab room link");
  }
  return current;
}

function toolDefinition(input: {
  agents: DshCollabToolAgentRegistry;
  agent: DshCollabScopedAgent;
  links: RoomSessionLinkStore;
  link: RoomSessionLink;
  publisher: WorkUpdatePublisher;
  isDisposed(): boolean;
}): DshCollabToolDefinition {
  return {
    name: "collab_publish_update",
    description: "Publish a concise update about work completed in this linked DSH Session to its Collab room.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", description: "Concise description of completed work. Do not include private prompts or tool logs." },
        filePaths: { type: "array", items: { type: "string" }, description: "Workspace-relative files relevant to the update." },
        changeSetId: { type: "string", description: "Optional immutable Collab ChangeSet identifier." },
      },
      required: ["summary", "filePaths"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          updateId: { type: "string" },
          roomId: { type: "string" },
          status: { type: "string", enum: ["published"] },
        },
        required: ["updateId", "roomId", "status"],
      },
      render: (_args, value) => [{ type: "text", text: `Published Collab work update ${(value as { updateId: string }).updateId}.` }],
    },
    async execute(rawArgs, execution) {
      if (input.isDisposed()) throw new Error("Collab publish tool binding is disposed");
      if (input.agents.get(input.link.sessionId) !== input.agent) throw new Error("Linked Session live Agent has changed");
      const link = currentLink(input.links, input.link);
      const args = parseArgs(rawArgs);
      const update = await input.publisher.publish({
        roomId: link.roomId,
        clientRequestId: idempotencyKey(link.sessionId, execution.callId),
        sourceSessionId: link.sessionId,
        summary: args.summary,
        filePaths: args.filePaths,
        ...(args.changeSetId === undefined ? {} : { changeSetId: args.changeSetId }),
        signal: execution.signal,
      });
      if (update.roomId !== link.roomId || update.authorId !== link.memberId || update.sourceSessionId !== link.sessionId) {
        throw new Error("Published Work Update identity does not match the Linked Session");
      }
      return { updateId: update.updateId, roomId: update.roomId, status: "published" };
    },
  };
}

export function bindCollabPublishUpdateTool(input: {
  agents: DshCollabToolAgentRegistry;
  links: RoomSessionLinkStore;
  sessionId: string;
  publisher: WorkUpdatePublisher;
}): CollabPublishUpdateToolBinding {
  const link = input.links.getBySession(input.sessionId);
  if (!link) throw new Error("Session is not linked to a Collab room");
  if (!link.active) throw new Error("Session does not have an active Collab room link");
  const agent = input.agents.get(input.sessionId);
  if (!agent || agent.id !== input.sessionId) throw new Error("Linked Session does not have a live Agent");
  let disposed = false;
  const unregister = agent.ctx.tools.register(toolDefinition({ ...input, agent, link, isDisposed: () => disposed }));
  let removeApprovalGate: () => void;
  try {
    removeApprovalGate = agent.ctx.on("tools/pre-execute", async (execution, next) => {
      if (execution.name !== "collab_publish_update") return await next();
      return { kind: "ask", reason: "Publish this Work Update to the linked Collab room?" };
    });
  } catch (error) {
    unregister();
    throw error;
  }
  return {
    roomId: link.roomId,
    sessionId: link.sessionId,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeApprovalGate();
      unregister();
    },
  };
}

export class GatewayWorkUpdatePublisher implements WorkUpdatePublisher {
  constructor(private readonly options: {
    transport: ParticipantGatewayTransport;
    tokenForRoom(roomId: string): string | undefined;
  }) {}

  async publish(input: PublishWorkUpdateRequest): Promise<WorkUpdate> {
    const token = this.options.tokenForRoom(input.roomId);
    if (!token) throw new Error("Collab room credential is unavailable");
    const response = await this.options.transport.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(input.roomId)}/work-updates`,
      token,
      body: {
        clientRequestId: input.clientRequestId,
        sourceSessionId: input.sourceSessionId,
        summary: input.summary,
        filePaths: input.filePaths,
        ...(input.changeSetId === undefined ? {} : { changeSetId: input.changeSetId }),
      },
      signal: input.signal,
    });
    if (response.status >= 400) throw new Error(`Work Update publication failed (${String(response.status)})`);
    const body = response.body as { update?: unknown };
    const update = validateWorkUpdate(body?.update);
    if (update.roomId !== input.roomId || update.sourceSessionId !== input.sourceSessionId) {
      throw new Error("Work Update response identity does not match request");
    }
    return update;
  }
}
