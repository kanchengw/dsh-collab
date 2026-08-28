import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { closeDshCollabRoom, DshCollabRoomsLauncher, DshCollabRoomsPanel, getDshCollabRoomSelection, openDshCollabOwnedRoom, openDshCollabRoom, setDshCollabRoomsOpen } from "../../src/collab-rooms.js";
import type { DshCollabSettingsPort } from "../../src/dsh-client.js";

function port(): DshCollabSettingsPort {
  return {
    getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "ws://192.168.1.20:4310/collab" }),
    getGatewaySnapshot: () => ({ status: "stopped" }),
    getOwnedRooms: () => [{ roomId: "room-owned", hostSessionId: "session-owned", title: "Release planning", sharing: false }],
    listJoinedRooms: () => [{ gatewayEndpoint: "wss://alice.example/collab", roomId: "room-joined", memberId: "member-bob", credential: "resume-secret", roomTitle: "Design review", hostDisplayName: "Alice" }],
    getRoomSnapshot: () => ({ roomId: "", roomTitle: "", hostDisplayName: "", role: "participant", connection: "offline" }),
    save: vi.fn(),
    startGateway: vi.fn(),
    stopGateway: vi.fn(),
    shareHostRoom: vi.fn(),
    stopSharing: vi.fn(),
    join: vi.fn(),
    connectJoinedRoom: vi.fn(),
    disconnectJoinedRoom: vi.fn(),
    forgetJoinedRoom: vi.fn(),
  };
}

describe("Collab Rooms navigation", () => {
  it("matches the DSH sidebar footer action in wide and rail layouts", () => {
    expect(renderToStaticMarkup(createElement(DshCollabRoomsLauncher, { wide: true }))).toContain("Collab Rooms");
    const rail = renderToStaticMarkup(createElement(DshCollabRoomsLauncher, { wide: false }));
    expect(rail).toContain('aria-label="Collab Rooms"');
    expect(rail).not.toContain("<span>Collab Rooms</span>");
  });

  it("shows explicit runtime controls for Owned rooms and Joined rooms", () => {
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, { port: port() }));
    setDshCollabRoomsOpen(false);

    expect(html).toContain("Gateway");
    expect(html).toContain("Stopped");
    expect(html).toContain("Start Gateway");
    expect(html).toContain("Owned rooms");
    expect(html).toContain("Release planning");
    expect(html).toContain("Not sharing");
    expect(html).toContain("Open room");
    expect(html).toContain("Start sharing");
    expect(html).toContain("Joined rooms");
    expect(html).toContain("Design review");
    expect(html).toContain("Hosted by Alice");
    expect(html).toContain("Disconnected");
    expect(html).toContain("Connect");
    expect(html).toContain("Forget");
    expect(html).toContain('name="participantInvitation"');
    expect(html).toContain('name="displayName"');
    expect(html).not.toContain("resume-secret");
    expect(html).not.toContain("Participating rooms");
  });

  it("stores Owned and Joined room navigation under the same Collab Rooms entry", () => {
    openDshCollabRoom({ kind: "owned", roomId: "room-owned", hostSessionId: "session-owned", roomTitle: "Release planning" });
    expect(getDshCollabRoomSelection()).toEqual(expect.objectContaining({ kind: "owned", roomId: "room-owned" }));

    openDshCollabRoom({ kind: "joined", roomId: "room-joined", gatewayEndpoint: "wss://alice.example/collab", roomTitle: "Design review", hostDisplayName: "Alice" });
    expect(getDshCollabRoomSelection()).toEqual(expect.objectContaining({ kind: "joined", roomId: "room-joined" }));

    closeDshCollabRoom();
    expect(getDshCollabRoomSelection()).toBeUndefined();
  });

  it("reconnects the browser projection before opening an Owned room that is already shared", async () => {
    const activePort = port();
    activePort.bootstrap = vi.fn(async () => {});
    const room = { roomId: "room-owned", hostSessionId: "session-owned", title: "Release planning", sharing: true };

    await openDshCollabOwnedRoom(activePort, room);

    expect(activePort.bootstrap).toHaveBeenCalledWith("room-owned");
    expect(getDshCollabRoomSelection()).toEqual({
      kind: "owned",
      roomId: "room-owned",
      hostSessionId: "session-owned",
      roomTitle: "Release planning",
    });
    closeDshCollabRoom();
  });

  it("requires disconnecting the active Joined room before connecting another", () => {
    const activePort = port();
    activePort.listJoinedRooms = () => [
      { gatewayEndpoint: "wss://alice.example/collab", roomId: "room-active", memberId: "member-bob", credential: "active-secret", roomTitle: "Active room" },
      { gatewayEndpoint: "wss://bob.example/collab", roomId: "room-other", memberId: "member-bob", credential: "other-secret", roomTitle: "Other room" },
    ];
    activePort.getRoomSnapshot = () => ({ roomId: "room-active", roomTitle: "Active room", hostDisplayName: "Alice", role: "participant", connection: "online" });
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, { port: activePort }));
    setDshCollabRoomsOpen(false);

    expect(html).toContain("Disconnect");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect<\/button>/);
  });
});
