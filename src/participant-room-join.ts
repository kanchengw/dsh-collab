import { DshRoomProjectRegistrar } from "./dsh-room-projects.js";
import type { RoomProject } from "./room-projects.js";
import { RoomWorkspaceMaterializer, type RoomWorkspace } from "./room-workspace.js";
import { validateWorkspaceVersionRecord, type WorkspaceVersionRecord } from "./workspace-versions.js";

export interface ParticipantWorkspaceVersionDownloader {
  downloadLatest(input: { roomId: string; token: string }): Promise<{ record: WorkspaceVersionRecord }>;
}

export interface ParticipantRoomWorkspaceJoinResult {
  project: RoomProject;
  workspace: RoomWorkspace;
}

/** Materializes a participant project only from an explicit, authenticated room join. */
export class ParticipantRoomWorkspaceJoiner {
  constructor(private readonly options: {
    versions: ParticipantWorkspaceVersionDownloader;
    materializer: RoomWorkspaceMaterializer;
    registrar: DshRoomProjectRegistrar;
  }) {}

  async join(input: {
    roomId: string;
    memberId: string;
    roomTitle: string;
    token: string;
  }): Promise<ParticipantRoomWorkspaceJoinResult> {
    const roomId = typeof input.roomId === "string" ? input.roomId.trim() : "";
    if (roomId === "") throw new Error("roomId must not be blank");
    const latest = await this.options.versions.downloadLatest({ roomId, token: input.token });
    const record = validateWorkspaceVersionRecord(latest.record);
    if (record.version.roomId !== roomId) throw new Error("Latest Workspace Version belongs to a different room");

    const workspace = await this.options.materializer.materialize({ roomId, record });
    return {
      project: await this.options.registrar.register({
        roomId,
        memberId: input.memberId,
        roomTitle: input.roomTitle,
        workspacePath: workspace.workspacePath,
      }),
      workspace,
    };
  }
}
