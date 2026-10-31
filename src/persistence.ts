import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { DshCollabHostRuntimeSnapshot } from "./host-runtime.js";
import type { DshCollabJoinedRoom } from "./settings-shared.js";

export function resolveDefaultCollabStateFile(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "state.json");
}

export function resolveDefaultCollabSnapshotDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "snapshots");
}

export function resolveDefaultCollabWorkspaceDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "workspaces");
}

export function resolveDefaultCollabRoomWorkspaceDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "rooms");
}

export function resolveDefaultCollabChangeSetDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "change-sets");
}

export function resolveDefaultCollabIntegrationJournalDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "integration-journals");
}

export function resolveDefaultCollabEasyTierDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "easytier");
}

export function resolveDefaultCollabEasyTierRunDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDefaultCollabEasyTierDir(env), "runs");
}

export function resolveDefaultCollabSideTaskFile(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "side-tasks.json");
}

export function resolveDefaultCollabParticipantRoomsFile(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "participant-rooms.json");
}

function decodeParticipantRooms(value: unknown): DshCollabJoinedRoom[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("dsh-collab participant rooms are malformed");
  const input = value as { version?: unknown; rooms?: unknown };
  if (input.version !== 1 || !Array.isArray(input.rooms)) throw new Error("dsh-collab participant rooms are malformed");
  return input.rooms.map((room) => {
    if (!room || typeof room !== "object" || Array.isArray(room)) throw new Error("dsh-collab participant room is malformed");
    const candidate = room as Record<string, unknown>;
    const required = ["gatewayEndpoint", "roomId", "memberId", "credentialKey"];
    if (required.some((field) => typeof candidate[field] !== "string" || (candidate[field] as string).trim() === "")) throw new Error("dsh-collab participant room is malformed");
    return {
      gatewayEndpoint: candidate.gatewayEndpoint as string,
      roomId: candidate.roomId as string,
      memberId: candidate.memberId as string,
      credentialKey: candidate.credentialKey as string,
      ...(typeof candidate.roomTitle === "string" && candidate.roomTitle ? { roomTitle: candidate.roomTitle } : {}),
      ...(typeof candidate.hostDisplayName === "string" && candidate.hostDisplayName ? { hostDisplayName: candidate.hostDisplayName } : {}),
      ...(typeof candidate.workspacePath === "string" && candidate.workspacePath ? { workspacePath: candidate.workspacePath } : {}),
      ...(Number.isSafeInteger(candidate.workspaceFileCount) && (candidate.workspaceFileCount as number) >= 0 ? { workspaceFileCount: candidate.workspaceFileCount as number } : {}),
      ...(Number.isSafeInteger(candidate.workspaceTotalBytes) && (candidate.workspaceTotalBytes as number) >= 0 ? { workspaceTotalBytes: candidate.workspaceTotalBytes as number } : {}),
    };
  });
}

export class ParticipantRoomsFile {
  private writes = Promise.resolve();

  constructor(readonly path: string) {}

  async load(): Promise<DshCollabJoinedRoom[]> {
    try {
      return decodeParticipantRooms(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  save(rooms: readonly DshCollabJoinedRoom[]): Promise<void> {
    const serialized = JSON.stringify({ version: 1, rooms }, null, 2) + "\n";
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = this.path + ".tmp";
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writes;
  }

  flush(): Promise<void> { return this.writes; }
}

function parseSnapshot(text: string): DshCollabHostRuntimeSnapshot {
  try {
    const value = JSON.parse(text) as DshCollabHostRuntimeSnapshot;
    if (!value || value.version !== 1) throw new Error("unsupported version");
    return value;
  } catch (error) {
    throw new Error("dsh-collab state is malformed", { cause: error });
  }
}

export class HostSnapshotFile {
  private writes = Promise.resolve();

  constructor(readonly path: string) {}

  loadSync(): DshCollabHostRuntimeSnapshot | undefined {
    try {
      return parseSnapshot(readFileSync(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async load(): Promise<DshCollabHostRuntimeSnapshot | undefined> {
    try {
      return parseSnapshot(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(snapshot: DshCollabHostRuntimeSnapshot): Promise<void> {
    const serialized = JSON.stringify(snapshot, null, 2) + "\n";
    return this.enqueue(() => serialized);
  }

  private enqueue(serialize: () => string): Promise<void> {
    this.writes = this.writes.catch(() => undefined).then(async () => {
      const serialized = serialize();
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = this.path + ".tmp";
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writes;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
