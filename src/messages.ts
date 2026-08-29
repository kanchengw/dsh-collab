import { invalidInput } from "./errors.js";
import type {
  AgentRequest,
  ClassifiedMessage,
  HumanMessage,
  MessageInput,
} from "./types.js";

const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_CONTEXT_REFS = 3;

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(field + " must not be blank", { field });
  }
  return value.trim();
}

export function classifyMessage(input: MessageInput): ClassifiedMessage {
  const messageId = requiredText(input.messageId, "messageId");
  const roomId = requiredText(input.roomId, "roomId");
  const authorMemberId = requiredText(input.authorMemberId, "authorMemberId");
  const text = requiredText(input.text, "text");
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw invalidInput("text exceeds the maximum length", { field: "text", max: MAX_MESSAGE_LENGTH });
  }

  const target = input.target ?? "room";
  if (target === "room") {
    const message: HumanMessage = {
      kind: "human",
      messageId,
      roomId,
      authorMemberId,
      text,
      visibility: "room",
    };
    return message;
  }
  if (target !== "dsh" && target !== "dsh-steer") {
    throw invalidInput("invalid message target", { target });
  }

  const message: AgentRequest = {
    kind: "agent-request",
    messageId,
    roomId,
    authorMemberId,
    text,
    target: "dsh",
    deliveryMode: target === "dsh-steer" ? "steer" : "followup",
  };
  if (input.sourceMessageId !== undefined) message.sourceMessageId = requiredText(input.sourceMessageId, "sourceMessageId");
  if (input.contextRefs !== undefined) {
    if (!Array.isArray(input.contextRefs)) throw invalidInput("contextRefs must be an array", { field: "contextRefs" });
    if (input.contextRefs.length > MAX_CONTEXT_REFS) throw invalidInput("too many context references", { field: "contextRefs", max: MAX_CONTEXT_REFS });
    message.contextRefs = input.contextRefs.map((ref) => requiredText(ref, "contextRef"));
  }
  return message;
}
