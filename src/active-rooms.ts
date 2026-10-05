import { CollabError } from "./errors.js";

export interface ActiveRoomRegistryOptions {
  /** Maximum number of active rooms. Omit for the protocol layer's legacy multi-room behavior. */
  maxActiveRooms?: number;
}

export class ActiveRoomRegistry {
  private readonly roomIds = new Set<string>();
  private readonly listeners = new Set<(roomId: string, active: boolean) => void>();
  private readonly maxActiveRooms: number;

  constructor(options: ActiveRoomRegistryOptions = {}) {
    const maxActiveRooms = options.maxActiveRooms ?? Number.POSITIVE_INFINITY;
    if (!(maxActiveRooms > 0) || (!Number.isInteger(maxActiveRooms) && maxActiveRooms !== Number.POSITIVE_INFINITY)) {
      throw new RangeError("maxActiveRooms must be a positive integer");
    }
    this.maxActiveRooms = maxActiveRooms;
  }

  isActive(roomId: string): boolean { return this.roomIds.has(roomId); }

  getActiveRoomId(): string | undefined { return this.roomIds.size === 1 ? this.roomIds.values().next().value : undefined; }

  assertCanActivate(roomId: string): void {
    if (this.isActive(roomId) || this.roomIds.size < this.maxActiveRooms) return;
    throw new CollabError(
      "REQUEST_CONFLICT",
      "another collaboration room is already active; stop it before activating another room",
      { roomId, activeRoomId: this.getActiveRoomId() },
    );
  }

  requireActive(roomId: string): void {
    if (!this.isActive(roomId)) throw new CollabError("ROOM_INACTIVE", "room is not currently shared", { roomId });
  }

  activate(roomId: string): void {
    if (this.isActive(roomId)) return;
    this.assertCanActivate(roomId);
    this.roomIds.add(roomId);
    for (const listener of this.listeners) listener(roomId, true);
  }

  deactivate(roomId: string): void {
    if (!this.roomIds.delete(roomId)) return;
    for (const listener of this.listeners) listener(roomId, false);
  }

  subscribe(listener: (roomId: string, active: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
