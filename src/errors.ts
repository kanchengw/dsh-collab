export type CollabErrorCode =
  | "INVALID_INPUT"
  | "ROOM_EXISTS"
  | "ROOM_NOT_FOUND"
  | "ROOM_INACTIVE"
  | "MEMBER_EXISTS"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_INACTIVE"
  | "EVENT_CONFLICT"
  | "REQUEST_CONFLICT"
  | "REQUEST_NOT_FOUND"
  | "REQUEST_STATE"
  | "SNAPSHOT_INVALID"
  | "INVITE_EXISTS"
  | "INVITE_NOT_FOUND"
  | "INVITE_INVALID"
  | "INVITE_EXPIRED"
  | "INVITE_REVOKED"
  | "INVITE_USED"
  | "INVITE_STATE"
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "TOKEN_SCOPE"
  | "CONNECTION_EXISTS"
  | "CONNECTION_NOT_FOUND"
  | "ACTION_FORBIDDEN"
  | "WORKSPACE_SHARING_DISABLED"
  | "RESOURCE_LIMIT";

export class CollabError extends Error {
  readonly code: CollabErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CollabErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CollabError";
    this.code = code;
    this.details = details;
  }
}

export function invalidInput(message: string, details?: Record<string, unknown>): CollabError {
  return new CollabError("INVALID_INPUT", message, details);
}
