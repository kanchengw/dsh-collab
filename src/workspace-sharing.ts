import type { WorkspaceSharingState } from "./collaboration-types.js";

export class WorkspaceSharingRegistry {
  private readonly states = new Map<string, WorkspaceSharingState>();

  get(roomId: string): WorkspaceSharingState {
    return structuredClone(this.states.get(roomId) ?? { roomId, enabled: false, revision: 0 });
  }

  set(roomId: string, enabled: boolean, enabledBy: string, now: number, revision: number): WorkspaceSharingState {
    const current = this.get(roomId);
    if (current.enabled === enabled) return current;
    if (!Number.isSafeInteger(revision) || revision <= current.revision) {
      throw new Error("Workspace Sharing revision must advance");
    }
    const state: WorkspaceSharingState = enabled
      ? { roomId, enabled: true, enabledBy, enabledAt: now, revision }
      : { roomId, enabled: false, revision };
    this.states.set(roomId, state);
    return structuredClone(state);
  }

  restore(state: WorkspaceSharingState): void {
    const current = this.states.get(state.roomId);
    if (current && state.revision < current.revision) throw new Error("Workspace Sharing restore revision must not go backwards");
    this.states.set(state.roomId, structuredClone(state));
  }

  clear(roomId: string): void {
    this.states.delete(roomId);
  }
}
