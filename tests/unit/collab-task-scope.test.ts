import { describe, expect, it, vi } from "vitest";
import { resolveCollabTasksPortForRoom } from "../../src/dsh-client.js";
import type { CollabTasksPort } from "../../src/collab-tasks.js";

function port(roomId: string, scoped?: CollabTasksPort): CollabTasksPort {
  return {
    getSnapshot: () => ({ roomId } as never),
    subscribe: () => () => {},
    refresh: vi.fn(async () => undefined),
    createTask: vi.fn(async () => undefined),
    selectTask: vi.fn(async () => undefined),
    claimTask: vi.fn(async () => undefined),
    setTaskStatus: vi.fn(async () => undefined),
    addTaskParticipant: vi.fn(async () => undefined),
    sendDiscussion: vi.fn(async () => undefined),
    ...(scoped ? { forRoom: () => scoped } : {}),
  };
}

describe("Collab Tasks room scoping", () => {
  it("rejects a global port whose snapshot belongs to another room", () => {
    expect(resolveCollabTasksPortForRoom(port("room-2"), "room-1")).toBeUndefined();
  });

  it("uses a room-scoped port when the service provides one", () => {
    const scoped = port("room-1");
    expect(resolveCollabTasksPortForRoom(port("room-2", scoped), "room-1")).toBe(scoped);
  });
});
