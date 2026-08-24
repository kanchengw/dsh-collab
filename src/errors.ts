export type CollabErrorCode =
  | "INVALID_INPUT"
  | "ROOM_EXISTS"
  | "ROOM_NOT_FOUND"
  | "MEMBER_EXISTS"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_INACTIVE"
  | "EVENT_CONFLICT"
  | "REQUEST_CONFLICT"
  | "REQUEST_NOT_FOUND"
  | "REQUEST_STATE"
  | "ACTION_FORBIDDEN";

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
