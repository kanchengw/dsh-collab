import { randomUUID } from "node:crypto";

/** Creates the opaque Room identity before a native Host Primary Session exists. */
export function createRoomProjectId(nextUuid: () => string = randomUUID): string {
  const value = nextUuid();
  if (typeof value !== "string" || value.trim() === "") throw new Error("Room id generator returned an empty value");
  return `room-${value.trim()}`;
}
