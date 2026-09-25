import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { CollabError, invalidInput } from "./errors.js";

export interface RoomProject {
  roomId: string;
  memberId: string;
  roomTitle: string;
  workspacePath: string;
  nativeWorkspaceId?: string;
  hostPrimarySessionId?: string;
}

export interface RoomProjectSnapshot {
  version: 1;
  projects: RoomProject[];
}

export interface RegisterRoomProjectInput {
  roomId: string;
  memberId: string;
  roomTitle: string;
  workspacePath: string;
}

export interface RoomProjectRegistrationOptions {
  replaceMember?: boolean;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(`${field} must not be blank`, { field });
  return value.trim();
}

function absolutePath(value: unknown, field: string): string {
  const path = requiredText(value, field);
  if (!isAbsolute(path)) throw invalidInput(`${field} must be absolute`, { field });
  return resolve(normalize(path));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function normalizeRegistration(input: RegisterRoomProjectInput): RoomProject {
  return {
    roomId: requiredText(input.roomId, "roomId"),
    memberId: requiredText(input.memberId, "memberId"),
    roomTitle: requiredText(input.roomTitle, "roomTitle"),
    workspacePath: absolutePath(input.workspacePath, "workspacePath"),
  };
}

function normalizeProject(value: unknown): RoomProject {
  const project = value as RoomProject;
  const normalized = normalizeRegistration(project);
  const nativeWorkspaceId = project?.nativeWorkspaceId;
  const hostPrimarySessionId = project?.hostPrimarySessionId;
  return {
    ...normalized,
    ...(nativeWorkspaceId === undefined ? {} : { nativeWorkspaceId: requiredText(nativeWorkspaceId, "nativeWorkspaceId") }),
    ...(hostPrimarySessionId === undefined ? {} : { hostPrimarySessionId: requiredText(hostPrimarySessionId, "hostPrimarySessionId") }),
  };
}

export function validateRoomProjectSnapshot(value: unknown): RoomProjectSnapshot {
  const snapshot = value as RoomProjectSnapshot;
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.projects)) {
    throw new CollabError("SNAPSHOT_INVALID", "Room Project snapshot is invalid");
  }
  try {
    const roomIds = new Set<string>();
    const workspacePaths: RoomProject[] = [];
    const nativeWorkspaceIds = new Set<string>();
    const hostPrimarySessionIds = new Set<string>();
    const projects = snapshot.projects.map((project) => {
      const normalized = normalizeProject(project);
      if (roomIds.has(normalized.roomId)) throw new Error("duplicate room");
      if (workspacePaths.some((candidate) => samePath(candidate.workspacePath, normalized.workspacePath))) {
        throw new Error("duplicate workspace path");
      }
      if (normalized.nativeWorkspaceId && nativeWorkspaceIds.has(normalized.nativeWorkspaceId)) {
        throw new Error("duplicate native workspace");
      }
      if (normalized.hostPrimarySessionId && hostPrimarySessionIds.has(normalized.hostPrimarySessionId)) {
        throw new Error("duplicate Host Primary Session");
      }
      roomIds.add(normalized.roomId);
      workspacePaths.push(normalized);
      if (normalized.nativeWorkspaceId) nativeWorkspaceIds.add(normalized.nativeWorkspaceId);
      if (normalized.hostPrimarySessionId) hostPrimarySessionIds.add(normalized.hostPrimarySessionId);
      return normalized;
    });
    return { version: 1, projects };
  } catch (error) {
    if (error instanceof CollabError && error.code === "SNAPSHOT_INVALID") throw error;
    throw new CollabError("SNAPSHOT_INVALID", "Room Project snapshot is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Local record of the one native DSH project that represents a room on this machine. */
export class RoomProjectStore {
  private readonly projects = new Map<string, RoomProject>();

  register(input: RegisterRoomProjectInput, options: RoomProjectRegistrationOptions = {}): RoomProject {
    const next = normalizeRegistration(input);
    const existing = this.projects.get(next.roomId);
    if (existing) {
      if (existing.memberId !== next.memberId) {
        if (!options.replaceMember) {
          throw new CollabError("REQUEST_CONFLICT", "Room Project belongs to another member; replace the member explicitly", {
            roomId: next.roomId,
          });
        }
        if (!samePath(existing.workspacePath, next.workspacePath)) {
          throw new CollabError("REQUEST_CONFLICT", "Room Project is already registered at another workspace", {
            roomId: next.roomId,
          });
        }
        existing.memberId = next.memberId;
      }
      if (!samePath(existing.workspacePath, next.workspacePath)) {
        throw new CollabError("REQUEST_CONFLICT", "Room Project is already registered at another workspace", {
          roomId: next.roomId,
        });
      }
      existing.roomTitle = next.roomTitle;
      return copy(existing);
    }
    if ([...this.projects.values()].some((project) => samePath(project.workspacePath, next.workspacePath))) {
      throw new CollabError("REQUEST_CONFLICT", "Workspace is already registered for another Room Project", {
        workspacePath: next.workspacePath,
      });
    }
    this.projects.set(next.roomId, next);
    return copy(next);
  }

  setNativeWorkspaceId(input: { roomId: string; nativeWorkspaceId: string }): RoomProject {
    const roomId = requiredText(input.roomId, "roomId");
    const nativeWorkspaceId = requiredText(input.nativeWorkspaceId, "nativeWorkspaceId");
    const project = this.projects.get(roomId);
    if (!project) throw new CollabError("REQUEST_NOT_FOUND", "Room Project does not exist", { roomId });
    const owner = [...this.projects.values()].find((candidate) => candidate.nativeWorkspaceId === nativeWorkspaceId);
    if (owner && owner.roomId !== roomId) {
      throw new CollabError("REQUEST_CONFLICT", "Native Workspace is already registered for another Room Project", {
        nativeWorkspaceId,
      });
    }
    project.nativeWorkspaceId = nativeWorkspaceId;
    return copy(project);
  }

  setHostPrimarySessionId(input: { roomId: string; sessionId: string }): RoomProject {
    const roomId = requiredText(input.roomId, "roomId");
    const sessionId = requiredText(input.sessionId, "sessionId");
    const project = this.projects.get(roomId);
    if (!project) throw new CollabError("REQUEST_NOT_FOUND", "Room Project does not exist", { roomId });
    if (project.hostPrimarySessionId && project.hostPrimarySessionId !== sessionId) {
      throw new CollabError("REQUEST_CONFLICT", "Room Project already has a Host Primary Session", { roomId });
    }
    const owner = [...this.projects.values()].find((candidate) => candidate.hostPrimarySessionId === sessionId);
    if (owner && owner.roomId !== roomId) {
      throw new CollabError("REQUEST_CONFLICT", "Host Primary Session is already registered for another Room Project", { sessionId });
    }
    project.hostPrimarySessionId = sessionId;
    return copy(project);
  }

  replaceMember(input: { roomId: string; memberId: string }): RoomProject {
    const roomId = requiredText(input.roomId, "roomId");
    const memberId = requiredText(input.memberId, "memberId");
    const project = this.projects.get(roomId);
    if (!project) throw new CollabError("REQUEST_NOT_FOUND", "Room Project does not exist", { roomId });
    project.memberId = memberId;
    return copy(project);
  }

  get(roomId: string): RoomProject | undefined {
    const project = this.projects.get(requiredText(roomId, "roomId"));
    return project ? copy(project) : undefined;
  }

  getByWorkspacePath(path: string): RoomProject | undefined {
    const workspacePath = absolutePath(path, "workspacePath");
    const project = [...this.projects.values()].find((candidate) => samePath(candidate.workspacePath, workspacePath));
    return project ? copy(project) : undefined;
  }

  list(): RoomProject[] {
    return [...this.projects.values()].map(copy);
  }

  snapshot(): RoomProjectSnapshot {
    return { version: 1, projects: this.list() };
  }

  static fromSnapshot(snapshot: RoomProjectSnapshot): RoomProjectStore {
    const validated = validateRoomProjectSnapshot(snapshot);
    const store = new RoomProjectStore();
    for (const project of validated.projects) store.projects.set(project.roomId, copy(project));
    return store;
  }
}

export function resolveDefaultRoomProjectFile(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v3", "room-projects.json");
}

function parseSnapshot(text: string): RoomProjectSnapshot {
  try {
    return validateRoomProjectSnapshot(JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error("dsh-collab Room Project state is malformed", { cause: error });
  }
}

export class RoomProjectFile {
  private writes = Promise.resolve();

  constructor(readonly path: string) {}

  loadSync(): RoomProjectSnapshot | undefined {
    try {
      return parseSnapshot(readFileSync(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async load(): Promise<RoomProjectSnapshot | undefined> {
    try {
      return parseSnapshot(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(snapshot: RoomProjectSnapshot): Promise<void> {
    const serialized = JSON.stringify(validateRoomProjectSnapshot(snapshot), null, 2) + "\n";
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path + ".tmp", serialized, { encoding: "utf8", mode: 0o600 });
      await rename(this.path + ".tmp", this.path);
    });
    return this.writes;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
