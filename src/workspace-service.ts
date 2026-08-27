import { CollabError } from "./errors.js";
import { RoomStore } from "./room.js";
import type { WorkspaceSharingState } from "./collaboration-types.js";
import { WorkspaceSharingRegistry } from "./workspace-sharing.js";

export class WorkspaceService {
  private readonly now: () => number;

  constructor(private readonly options: {
    rooms: RoomStore;
    registry: WorkspaceSharingRegistry;
    now?: () => number;
  }) {
    this.now = options.now ?? (() => Date.now());
  }

  getState(input: { roomId: string; principalId: string }): WorkspaceSharingState {
    this.options.rooms.authorize(input.roomId, input.principalId, "read");
    return this.options.registry.get(input.roomId);
  }

  setSharing(input: { roomId: string; principalId: string; enabled: boolean }): WorkspaceSharingState {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (member.role !== "host") {
      throw new CollabError("ACTION_FORBIDDEN", "only the Host can change Workspace Sharing");
    }
    return this.options.registry.set(input.roomId, input.enabled, member.memberId, this.now());
  }

  requireWorkspaceRead(input: { roomId: string; principalId: string }): WorkspaceSharingState {
    const state = this.getState(input);
    if (!state.enabled) {
      throw new CollabError("WORKSPACE_SHARING_DISABLED", "Workspace Sharing is disabled", { roomId: input.roomId });
    }
    return state;
  }

  clearRoom(roomId: string): void {
    this.options.registry.clear(roomId);
  }
}
