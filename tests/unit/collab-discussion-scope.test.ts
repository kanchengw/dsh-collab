import { describe, expect, it, vi } from "vitest";
import { resolveCollabDiscussionPortForRoom } from "../../src/dsh-client.js";
import type { CollabDiscussionViewPort } from "../../src/collab-discussion.js";

function port(roomId: string, scoped?: CollabDiscussionViewPort): CollabDiscussionViewPort {
  return {
    getSnapshot: () => ({ roomId, connection: "online", messages: [], scopes: [{ value: "general", label: "General" }] }),
    subscribe: () => () => {},
    send: vi.fn(async () => undefined),
    ...(scoped ? { forRoom: () => scoped } : {}),
  };
}

describe("Collab Discussion room scoping", () => {
  it("rejects a discussion port from another room", () => {
    expect(resolveCollabDiscussionPortForRoom(port("room-2"), "room-1")).toBeUndefined();
  });

  it("uses the room-scoped discussion port", () => {
    const scoped = port("room-1");
    expect(resolveCollabDiscussionPortForRoom(port("room-2", scoped), "room-1")).toBe(scoped);
  });
});
