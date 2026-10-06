import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { createRoomProjectId } from "./room-project-identity.js";
import type { RoomProjectStore } from "./room-projects.js";
import type { RoomStore } from "./room.js";
import type { EventLedger } from "./events.js";
import type { WorkspaceService } from "./workspace-service.js";
import type { WorkspaceVersionRecord, WorkspaceVersionService } from "./workspace-versions.js";

export interface OwnerRoomProjectPrepareInput {
  sourcePath: string;
  sourceSessionId: string;
  roomTitle: string;
}

export interface OwnerRoomProjectPrepareResult {
  roomId: string;
  workspacePath: string;
  nativeWorkspaceId: string;
}

export interface OwnerRoomProjectCompleteInput {
  roomId: string;
  sourceSessionId: string;
  hostPrimarySessionId: string;
}

interface OwnerRoomProjectBootstrap {
  prepare(input: {
    roomId: string;
    memberId: string;
    roomTitle: string;
    sourcePath: string;
    nativeWorkspaceTitle: string;
    initialVersion: WorkspaceVersionRecord;
  }): Promise<{
    project: { roomId: string; nativeWorkspaceId?: string };
    workspace: { workspacePath: string };
  }>;
  complete(input: { roomId: string; sessionId: string }): Promise<unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must not be blank`);
  return value.trim();
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export class OwnerRoomProjectService {
  constructor(private readonly options: {
    hostId: string;
    hostDisplayName: string;
    sessions: { workspacePath?(sessionId: string): string | Promise<string | undefined> | undefined };
    rooms: RoomStore;
    roomProjects: RoomProjectStore;
    ledger: Pick<EventLedger, "latestSeq" | "discardRoom">;
    workspace: Pick<WorkspaceService, "setSharing" | "clearRoom" | "captureLatest">;
    workspaceVersions: Pick<WorkspaceVersionService, "create">;
    bootstrap: OwnerRoomProjectBootstrap;
    commitCriticalState(): Promise<void>;
    createRoomId?: () => string;
  }) {}

  async prepare(input: OwnerRoomProjectPrepareInput): Promise<OwnerRoomProjectPrepareResult> {
    const sourceSessionId = requiredText(input.sourceSessionId, "sourceSessionId");
    const sourcePath = await realpath(requiredText(input.sourcePath, "sourcePath"));
    const sessionPath = await this.options.sessions.workspacePath?.(sourceSessionId);
    if (!sessionPath || !samePath(sourcePath, await realpath(sessionPath))) {
      throw new Error("Selected workspace path does not match the source DSH Session");
    }
    const roomTitle = requiredText(input.roomTitle, "roomTitle");
    const roomId = (this.options.createRoomId ?? createRoomProjectId)();
    this.options.rooms.createRoom({
      roomId,
      hostId: this.options.hostId,
      hostSessionId: sourceSessionId,
      title: roomTitle,
      hostDisplayName: this.options.hostDisplayName,
    });
    try {
      this.options.workspace.setSharing({ roomId, principalId: this.options.hostId, enabled: true });
      const snapshot = await this.options.workspace.captureLatest({
        roomId,
        principalId: this.options.hostId,
        clientRequestId: `owner-room-project:${roomId}`,
        purpose: "workspace-version",
        roomEventSeq: this.options.ledger.latestSeq(roomId),
      });
      const version = await this.options.workspaceVersions.create({
        roomId,
        principalId: this.options.hostId,
        snapshotId: snapshot.snapshotId,
      });
      const prepared = await this.options.bootstrap.prepare({
        roomId,
        memberId: "member-host",
        roomTitle,
        sourcePath,
        nativeWorkspaceTitle: basename(sourcePath) + " · " + roomTitle,
        initialVersion: version.record,
      });
      if (!prepared.project.nativeWorkspaceId) throw new Error("Native Workspace registration is missing");
      await this.options.commitCriticalState();
      return {
        roomId,
        workspacePath: prepared.workspace.workspacePath,
        nativeWorkspaceId: prepared.project.nativeWorkspaceId,
      };
    } catch (error) {
      this.options.roomProjects.remove(roomId);
      this.options.workspace.clearRoom(roomId);
      this.options.ledger.discardRoom(roomId);
      this.options.rooms.removeRoom(roomId);
      await this.options.commitCriticalState().catch(() => undefined);
      throw error;
    }
  }

  async complete(input: OwnerRoomProjectCompleteInput): Promise<{ roomId: string; hostPrimarySessionId: string }> {
    const roomId = requiredText(input.roomId, "roomId");
    const sourceSessionId = requiredText(input.sourceSessionId, "sourceSessionId");
    const hostPrimarySessionId = requiredText(input.hostPrimarySessionId, "hostPrimarySessionId");
    const project = this.options.roomProjects.get(roomId);
    if (!project) throw new Error("Room Project does not exist");
    const room = this.options.rooms.getRoom(roomId);
    if (room.hostId !== this.options.hostId) throw new Error("Only the Room Host can complete the Room Project");
    if (room.hostSessionId !== sourceSessionId && room.hostSessionId !== hostPrimarySessionId) {
      throw new Error("Room is no longer bound to the expected Host Session");
    }
    const targetPath = await this.options.sessions.workspacePath?.(hostPrimarySessionId);
    if (!targetPath || !samePath(await realpath(targetPath), await realpath(project.workspacePath))) {
      throw new Error("Host Primary Session does not belong to the Room Project workspace");
    }

    await this.options.bootstrap.complete({ roomId, sessionId: hostPrimarySessionId });
    this.options.rooms.rebindHostSession({
      roomId,
      hostId: this.options.hostId,
      fromSessionId: sourceSessionId,
      toSessionId: hostPrimarySessionId,
    });
    await this.options.commitCriticalState();
    return { roomId, hostPrimarySessionId };
  }
}
