import { describe, expect, it, vi } from "vitest";
import { ActiveRoomRegistry } from "../../src/active-rooms.js";

describe("ActiveRoomRegistry", () => {
  it("can enforce a single active room without changing the default protocol registry behavior", () => {
    const listener = vi.fn();
    const registry = new ActiveRoomRegistry({ maxActiveRooms: 1 });
    registry.subscribe(listener);

    registry.activate("room-1");

    expect(registry.isActive("room-1")).toBe(true);
    expect(registry.getActiveRoomId()).toBe("room-1");
    expect(() => registry.activate("room-2")).toThrow("another collaboration room is already active");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("allows the next room after the current room is deactivated", () => {
    const registry = new ActiveRoomRegistry({ maxActiveRooms: 1 });
    registry.activate("room-1");
    registry.deactivate("room-1");

    registry.activate("room-2");

    expect(registry.getActiveRoomId()).toBe("room-2");
  });

  it("keeps the existing multi-room behavior when no limit is configured", () => {
    const registry = new ActiveRoomRegistry();

    registry.activate("room-1");
    registry.activate("room-2");

    expect(registry.isActive("room-1")).toBe(true);
    expect(registry.isActive("room-2")).toBe(true);
  });
});
