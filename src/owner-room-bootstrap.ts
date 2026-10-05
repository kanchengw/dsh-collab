import { DshRoomProjectRegistrar } from "./dsh-room-projects.js";
import type { RoomProject } from "./room-projects.js";
import { RoomWorkspaceMaterializer, type RoomWorkspace } from "./room-workspace.js";
import { validateWorkspaceVersionRecord, type WorkspaceVersionRecord } from "./workspace-versions.js";

export interface DshRoomProjectNavigationService {
  connectWorkspace(workspaceId: string): Promise<string>;
  openSession(sessionId: string): void;
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
    workspaceNavigation?: DshRoomProjectNavigationService;
  }) {}

  async create(input: {
    roomId: string;
    memberId: string;
    roomTitle: string;
    sourcePath?: string;
    initialVersion: WorkspaceVersionRecord;
  }): Promise<OwnerRoomWorkspaceBootstrapResult> {
    if (!this.options.workspaceNavigation) throw new Error("DSH Workspace navigation is unavailable");
    const prepared = await this.prepare(input);
    if (prepared.project.hostPrimarySessionId) return prepared;
    if (!prepared.project.nativeWorkspaceId) throw new Error("Native Workspace registration is missing");

    const sessionId = await this.options.workspaceNavigation.connectWorkspace(prepared.project.nativeWorkspaceId);
    this.options.workspaceNavigation.openSession(sessionId);
    return {
      project: await this.complete({ roomId: prepared.project.roomId, sessionId }),
      workspace: prepared.workspace,
    };
  }

  async prepare(input: {
    roomId: string;
    memberId: string;
    roomTitle: string;
    sourcePath?: string;
    nativeWorkspaceTitle?: string;
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
      ...(input.nativeWorkspaceTitle ? { nativeWorkspaceTitle: input.nativeWorkspaceTitle } : {}),
      workspacePath: workspace.workspacePath,
      ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    });
    return { project, workspace };
  }

  complete(input: { roomId: string; sessionId: string }): Promise<RoomProject> {
    return this.options.registrar.recordHostPrimarySession(input);
  }
}
