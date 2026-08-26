import { CollabError } from "./errors.js";

export class ActiveRoomRegistry {
  private readonly roomIds = new Set<string>();
  private readonly listeners = new Set<(roomId: string, active: boolean) => void>();

  isActive(roomId: string): boolean { return this.roomIds.has(roomId); }

  requireActive(roomId: string): void {
    if (!this.isActive(roomId)) throw new CollabError("ROOM_INACTIVE", "room is not currently shared", { roomId });
  }

  activate(roomId: string): void {
    if (this.roomIds.has(roomId)) return;
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
