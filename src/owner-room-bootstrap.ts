import { DshRoomProjectRegistrar } from "./dsh-room-projects.js";
import type { RoomProject } from "./room-projects.js";
import { RoomWorkspaceMaterializer, type RoomWorkspace } from "./room-workspace.js";
import { validateWorkspaceVersionRecord, type WorkspaceVersionRecord } from "./workspace-versions.js";

export interface DshRoomProjectConnectionService {
  connectWorkspace(workspaceId: string): Promise<string>;
}

export interface OwnerRoomWorkspaceBootstrapResult {
  project: RoomProject;
  workspace: RoomWorkspace;
}

/** Creates the room-owned workspace before opening its one Host Primary Session. */
export class OwnerRoomWorkspaceBootstrapper {
  constructor(private readonly options: {
    materializer: RoomWorkspaceMaterializer;
    registrar: DshRoomProjectRegistrar;
    workspaces: DshRoomProjectConnectionService;
  }) {}

  async create(input: {
    roomId: string;
    memberId: string;
    roomTitle: string;
    initialVersion: WorkspaceVersionRecord;
  }): Promise<OwnerRoomWorkspaceBootstrapResult> {
    const roomId = typeof input.roomId === "string" ? input.roomId.trim() : "";
    if (roomId === "") throw new Error("roomId must not be blank");
    const initialVersion = validateWorkspaceVersionRecord(input.initialVersion);
    if (initialVersion.version.roomId !== roomId) throw new Error("Initial Workspace Version belongs to a different room");

    const workspace = await this.options.materializer.materialize({ roomId, record: initialVersion });
    const project = await this.options.registrar.register({
      roomId,
      memberId: input.memberId,
      roomTitle: input.roomTitle,
      workspacePath: workspace.workspacePath,
    });
    if (project.hostPrimarySessionId) return { project, workspace };
    if (!project.nativeWorkspaceId) throw new Error("Native Workspace registration is missing");

    const sessionId = await this.options.workspaces.connectWorkspace(project.nativeWorkspaceId);
    return {
      project: await this.options.registrar.recordHostPrimarySession({ roomId, sessionId }),
      workspace,
    };
  }
}
