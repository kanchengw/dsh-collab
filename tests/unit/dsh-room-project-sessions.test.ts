import { describe, expect, it } from "vitest";
import {
  DshRoomProjectSessionObserver,
  formatInitialRoomProjectContext,
  type DshRoomProjectSessionListSnapshot,
} from "../../src/dsh-room-project-sessions.js";
import { RoomProjectStore } from "../../src/room-projects.js";

class FakeSessionList {
  private readonly listeners = new Set<() => void>();

  constructor(private snapshot: DshRoomProjectSessionListSnapshot) {}

  getSnapshot(): DshRoomProjectSessionListSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  set(snapshot: DshRoomProjectSessionListSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function roomProjects(): RoomProjectStore {
  const projects = new RoomProjectStore();
  projects.register({
    roomId: "room-1",
    memberId: "member-1",
    roomTitle: "Atlas",
    workspacePath: "C:\\rooms\\atlas",
  });
  return projects;
}

function sessionList(rows: Array<{ id: string; cwd?: string }>): DshRoomProjectSessionListSnapshot {
  return {
    ids: rows.map((row) => row.id),
    byId: Object.fromEntries(rows.map((row) => [row.id, row])),
  };
}

describe("DshRoomProjectSessionObserver", () => {
  it("associates new and restored Room Project Sessions and injects only their initial room context", () => {
    const sessions = new FakeSessionList(sessionList([
      { id: "restored-room-session", cwd: "C:\\rooms\\atlas" },
      { id: "private-session", cwd: "C:\\projects\\private" },
    ]));
    const deliveries: Array<{ sessionId: string; deliveryId: string; text: string }> = [];
    const observer = new DshRoomProjectSessionObserver({
      projects: roomProjects(),
      sessions,
      bind: (sessionId) => ({
        deliver: (input) => {
          deliveries.push({ sessionId, ...input });
          return { ...input, messageId: "message-1", state: "injected" as const };
        },
      }),
    });

    observer.start();

    expect(observer.list()).toEqual([{
      sessionId: "restored-room-session",
      roomId: "room-1",
      memberId: "member-1",
      workspacePath: "C:\\rooms\\atlas",
      initialContextDelivered: true,
    }]);
    expect(deliveries).toEqual([{
      sessionId: "restored-room-session",
      deliveryId: "room-project-context:room-1:member-1:restored-room-session",
      text: formatInitialRoomProjectContext({
        roomId: "room-1",
        memberId: "member-1",
        roomTitle: "Atlas",
        workspacePath: "C:\\rooms\\atlas",
      }),
    }]);

    sessions.set(sessionList([
      { id: "restored-room-session", cwd: "C:\\rooms\\atlas" },
      { id: "new-room-session", cwd: "C:\\rooms\\atlas" },
      { id: "private-session", cwd: "C:\\projects\\private" },
    ]));

    expect(observer.get("new-room-session")).toMatchObject({ roomId: "room-1", initialContextDelivered: true });
    expect(deliveries.map((delivery) => delivery.sessionId)).toEqual(["restored-room-session", "new-room-session"]);
  });

  it("does not bind or inject an unrelated native Session", () => {
    const sessions = new FakeSessionList(sessionList([{ id: "private-session", cwd: "C:\\projects\\private" }]));
    const bound: string[] = [];
    const observer = new DshRoomProjectSessionObserver({
      projects: roomProjects(),
      sessions,
      bind: (sessionId) => {
        bound.push(sessionId);
        return undefined;
      },
    });

    observer.start();

    expect(observer.list()).toEqual([]);
    expect(bound).toEqual([]);
  });

  it("retains an association until a live Agent context binding becomes available", () => {
    const sessions = new FakeSessionList(sessionList([{ id: "room-session", cwd: "C:\\rooms\\atlas" }]));
    const deliveries: string[] = [];
    let ready = false;
    const observer = new DshRoomProjectSessionObserver({
      projects: roomProjects(),
      sessions,
      bind: (sessionId) => ready
        ? { deliver: (input) => { deliveries.push(`${sessionId}:${input.deliveryId}`); return { ...input, messageId: "message-1", state: "injected" as const }; } }
        : undefined,
    });

    observer.start();
    expect(observer.get("room-session")).toMatchObject({ initialContextDelivered: false });

    ready = true;
    observer.reconcile();

    expect(observer.get("room-session")).toMatchObject({ initialContextDelivered: true });
    expect(deliveries).toEqual(["room-session:room-project-context:room-1:member-1:room-session"]);
  });
});
