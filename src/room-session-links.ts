import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { CollabError, invalidInput } from "./errors.js";

export interface RoomSessionLink {
  roomId: string;
  memberId: string;
  sessionId: string;
  workspacePath: string;
  lastInjectedRoomSeq: number;
  active: boolean;
}

export interface RoomSessionLinkSnapshot {
  version: 1;
  links: RoomSessionLink[];
}

export interface BindRoomSessionInput {
  roomId: string;
  memberId: string;
  sessionId: string;
  workspacePath: string;
  sessionCwd: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(`${field} must not be blank`, { field });
  return value.trim();
}

function workspacePath(value: unknown, field: string): string {
  const path = requiredText(value, field);
  if (!isAbsolute(path)) throw invalidInput(`${field} must be absolute`, { field });
  return resolve(normalize(path));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validSeq(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function validateRoomSessionLinkSnapshot(value: unknown): RoomSessionLinkSnapshot {
  const snapshot = value as RoomSessionLinkSnapshot;
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.links)) {
    throw new CollabError("SNAPSHOT_INVALID", "Room Session Link snapshot is invalid");
  }
  const sessions = new Set<string>();
  const activeMembers = new Set<string>();
  const links: RoomSessionLink[] = [];
  try {
    for (const candidate of snapshot.links) {
      const roomId = requiredText(candidate?.roomId, "roomId");
      const memberId = requiredText(candidate?.memberId, "memberId");
      const sessionId = requiredText(candidate?.sessionId, "sessionId");
      const path = workspacePath(candidate?.workspacePath, "workspacePath");
      if (!validSeq(candidate?.lastInjectedRoomSeq) || typeof candidate?.active !== "boolean" || sessions.has(sessionId)) {
        throw new Error("invalid link");
      }
      const activeKey = `${roomId}\0${memberId}`;
      if (candidate.active && activeMembers.has(activeKey)) throw new Error("multiple active links");
      sessions.add(sessionId);
      if (candidate.active) activeMembers.add(activeKey);
      links.push({ roomId, memberId, sessionId, workspacePath: path, lastInjectedRoomSeq: candidate.lastInjectedRoomSeq, active: candidate.active });
    }
  } catch (error) {
    if (error instanceof CollabError && error.code === "SNAPSHOT_INVALID") throw error;
    throw new CollabError("SNAPSHOT_INVALID", "Room Session Link snapshot is invalid", { cause: error instanceof Error ? error.message : String(error) });
  }
  return { version: 1, links };
}

export function resolveDefaultRoomSessionLinkFile(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v2", "session-links.json");
}

export class RoomSessionLinkStore {
  private readonly links = new Map<string, RoomSessionLink>();

  bind(input: BindRoomSessionInput): RoomSessionLink {
    const roomId = requiredText(input.roomId, "roomId");
    const memberId = requiredText(input.memberId, "memberId");
    const sessionId = requiredText(input.sessionId, "sessionId");
    const path = workspacePath(input.workspacePath, "workspacePath");
    const cwd = workspacePath(input.sessionCwd, "sessionCwd");
    if (!samePath(path, cwd)) throw invalidInput("Session cwd does not match the room workspace", { sessionId });

    const existing = this.links.get(sessionId);
    if (existing && (existing.roomId !== roomId || existing.memberId !== memberId)) {
      throw new CollabError("REQUEST_CONFLICT", "Session is already bound to another room or member", { sessionId });
    }
    if (existing && !samePath(existing.workspacePath, path)) {
      throw new CollabError("REQUEST_CONFLICT", "Session is already bound to another workspace", { sessionId });
    }

    for (const link of this.links.values()) {
      if (link.roomId === roomId && link.memberId === memberId && link.sessionId !== sessionId) link.active = false;
    }
    const link = existing ?? { roomId, memberId, sessionId, workspacePath: path, lastInjectedRoomSeq: 0, active: true };
    link.active = true;
    this.links.set(sessionId, link);
    return copy(link);
  }

  getBySession(sessionId: string): RoomSessionLink | undefined {
    const link = this.links.get(requiredText(sessionId, "sessionId"));
    return link ? copy(link) : undefined;
  }

  getActive(roomId: string, memberId: string): RoomSessionLink | undefined {
    const normalizedRoomId = requiredText(roomId, "roomId");
    const normalizedMemberId = requiredText(memberId, "memberId");
    const link = [...this.links.values()].find((candidate) => candidate.roomId === normalizedRoomId && candidate.memberId === normalizedMemberId && candidate.active);
    return link ? copy(link) : undefined;
  }

  list(): RoomSessionLink[] {
    return [...this.links.values()].map(copy);
  }

  advanceCursor(sessionId: string, lastInjectedRoomSeq: number): RoomSessionLink {
    const normalizedSessionId = requiredText(sessionId, "sessionId");
    if (!validSeq(lastInjectedRoomSeq)) throw invalidInput("lastInjectedRoomSeq must be a non-negative integer");
    const link = this.links.get(normalizedSessionId);
    if (!link) throw new CollabError("REQUEST_NOT_FOUND", "Room Session Link does not exist", { sessionId: normalizedSessionId });
    if (lastInjectedRoomSeq < link.lastInjectedRoomSeq) {
      throw new CollabError("REQUEST_CONFLICT", "Room Session Link cursor cannot move backwards", { sessionId: normalizedSessionId });
    }
    link.lastInjectedRoomSeq = lastInjectedRoomSeq;
    return copy(link);
  }

  unbind(sessionId: string): boolean {
    return this.links.delete(requiredText(sessionId, "sessionId"));
  }

  snapshot(): RoomSessionLinkSnapshot {
    return { version: 1, links: this.list() };
  }

  static fromSnapshot(snapshot: RoomSessionLinkSnapshot): RoomSessionLinkStore {
    const validated = validateRoomSessionLinkSnapshot(snapshot);
    const store = new RoomSessionLinkStore();
    for (const link of validated.links) store.links.set(link.sessionId, copy(link));
    return store;
  }
}

function parseFile(text: string): RoomSessionLinkSnapshot {
  try {
    return validateRoomSessionLinkSnapshot(JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error("dsh-collab Room Session Link state is malformed", { cause: error });
  }
}

export class RoomSessionLinkFile {
  private writes = Promise.resolve();

  constructor(readonly path: string) {}

  loadSync(): RoomSessionLinkSnapshot | undefined {
    try {
      return parseFile(readFileSync(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async load(): Promise<RoomSessionLinkSnapshot | undefined> {
    try {
      return parseFile(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(snapshot: RoomSessionLinkSnapshot): Promise<void> {
    const serialized = JSON.stringify(validateRoomSessionLinkSnapshot(snapshot), null, 2) + "\n";
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
