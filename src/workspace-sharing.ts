import type { CollaborationEvent, WorkspaceSharingState } from "./collaboration-types.js";

type Listener = (event: CollaborationEvent) => void;

export class WorkspaceSharingRegistry {
  private readonly states = new Map<string, WorkspaceSharingState>();
  private readonly listeners = new Set<Listener>();

  get(roomId: string): WorkspaceSharingState {
    return structuredClone(this.states.get(roomId) ?? { roomId, enabled: false, revision: 0 });
  }

  set(roomId: string, enabled: boolean, enabledBy: string, now: number): WorkspaceSharingState {
    const current = this.get(roomId);
    if (current.enabled === enabled) return current;
    const state: WorkspaceSharingState = enabled
      ? { roomId, enabled: true, enabledBy, enabledAt: now, revision: current.revision + 1 }
      : { roomId, enabled: false, revision: current.revision + 1 };
    this.states.set(roomId, state);
    const event: CollaborationEvent = { type: "workspace-sharing.changed", state: structuredClone(state) };
    for (const listener of this.listeners) listener(event);
    return structuredClone(state);
  }

  clear(roomId: string): void {
    this.states.delete(roomId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
