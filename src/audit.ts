import { EventLedger } from "./events.js";
import { RoomStore } from "./room.js";
import type { RoomEvent } from "./types.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|access[_-]?key|refresh[_-]?token|private[_-]?key|credential|cookie/i;
const PATH_KEY = /^(path|filepath|file_path|cwd|workdir|workingdirectory|working_directory)$/i;
const ENV_KEY = /^(env|environment|environmentvariables|environment_variables)$/i;
const TOOL_ARGS_KEY = /^(args|arguments|toolargs|toolarguments|tool_args|tool_arguments)$/i;

function shouldRedact(key: string): boolean {
  return SENSITIVE_KEY.test(key) || PATH_KEY.test(key) || ENV_KEY.test(key) || TOOL_ARGS_KEY.test(key);
}

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer " + REDACTED)
    .replace(/\b(?:token|secret|password|api[_-]?key)=\S+/gi, (match) => match.split("=", 1)[0] + "=" + REDACTED);
}

export function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) output[key] = shouldRedact(key) ? REDACTED : redactSensitive(child);
  return output;
}

export interface AuditExportOptions {
  rooms: RoomStore;
  ledger: EventLedger;
  roomId: string;
  principalId: string;
  afterSeq?: number;
  limit?: number;
}

export interface AuditExport {
  version: 1;
  roomId: string;
  events: RoomEvent[];
}

export function exportAudit(options: AuditExportOptions): AuditExport {
  options.rooms.authorize(options.roomId, options.principalId, "manageMembers");
  const events = options.ledger.readAfter(options.roomId, options.afterSeq ?? 0, options.limit ?? 500);
  return {
    version: 1,
    roomId: options.roomId,
    events: redactSensitive(events) as RoomEvent[],
  };
}
