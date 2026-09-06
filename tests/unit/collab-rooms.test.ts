import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { closeDshCollabRoom, createDshCollabInvitation, DshCollabRoomsLauncher, DshCollabRoomsPanel, getDshCollabRoomSelection, openDshCollabOwnedRoom, openDshCollabRoom, setDshCollabRoomsOpen, shareDshCollabOwnedRoom } from "../../src/collab-rooms.js";
import type { DshCollabSettingsPort } from "../../src/dsh-client.js";
import type { CollabPanelHost } from "../../src/collab-panel-host.js";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", async () => {
  const React = await import("react");
  return {
    Modal: ({ open, children, className }: { open: boolean; children: React.ReactNode; className?: string }) => open
      ? React.createElement("div", { "data-dsh-modal": "true", className }, children)
      : null,
  };
});

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

    expect(html).not.toContain("Start Gateway");
    expect(html).not.toContain("Stop Gateway");
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
    expect(html).toContain('data-collab-join-disclosure="true"');
    expect(html).toContain("Join a room");
    expect(html).not.toContain("resume-secret");
    expect(html).not.toContain("Participating rooms");
  });

  it("does not bind a Joined room to the active unrelated Session", () => {
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, {
      port: port(),
      panelHost: {
        kind: "ready",
        version: "0.17.1",
        host: { register: () => () => {}, open: vi.fn() },
        getActiveTarget: () => ({ sessionId: "unrelated-session", cwd: "C:/private" }),
      },
    }));
    setDshCollabRoomsOpen(false);

    expect((html.match(/>Open room</g) ?? []).length).toBe(1);
  });

  it("uses the DSH portal-backed Modal so the room drawer escapes shell stacking contexts", () => {
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, { port: port() }));
    setDshCollabRoomsOpen(false);

    expect(html).toContain('data-dsh-modal="true"');
  });

  it("keeps invitation creation in the shared Owned room manager", () => {
    const actions = port();
    actions.getOwnedRooms = () => [{ roomId: "room-owned", hostSessionId: "session-owned", title: "Release planning", sharing: true }];
    actions.createInvite = vi.fn();
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, { port: actions }));
    setDshCollabRoomsOpen(false);

    expect(html).toContain("Create invitation");
    expect(html).toContain("Stop sharing");
  });

  it("explains the optional Better Sidebar requirement without hiding room management", () => {
    setDshCollabRoomsOpen(true);
    const missing = renderToStaticMarkup(createElement(DshCollabRoomsPanel, {
      port: port(),
      panelHost: { kind: "missing", requiredVersion: "0.17.1" },
    }));
    const incompatible = renderToStaticMarkup(createElement(DshCollabRoomsPanel, {
      port: port(),
      panelHost: { kind: "incompatible", reason: "version", requiredVersion: "0.17.1", actualVersion: "0.17.0" },
    }));
    setDshCollabRoomsOpen(false);

    expect(missing).toContain("Install a compatible dsh-better-sidebar 0.17.x release (minimum 0.17.1) to open the Collab Bar");
    expect(missing).toContain("Owned rooms");
    expect(incompatible).toContain("Use a compatible dsh-better-sidebar 0.17.x release (minimum 0.17.1)");
    expect(incompatible).toContain("Joined rooms");
  });

  it("stores Owned and Joined room navigation under the same Collab Rooms entry", () => {
    openDshCollabRoom({ kind: "owned", roomId: "room-owned", hostSessionId: "session-owned", roomTitle: "Release planning" });
    expect(getDshCollabRoomSelection()).toEqual(expect.objectContaining({ kind: "owned", roomId: "room-owned" }));

    openDshCollabRoom({ kind: "joined", roomId: "room-joined", gatewayEndpoint: "wss://alice.example/collab", roomTitle: "Design review", hostDisplayName: "Alice" });
    expect(getDshCollabRoomSelection()).toEqual(expect.objectContaining({ kind: "joined", roomId: "room-joined" }));

    closeDshCollabRoom();
    expect(getDshCollabRoomSelection()).toBeUndefined();
  });

  it("binds the selected room to the Session targeted by the Collab Panel Host", () => {
    const opened: Array<{ sessionId: string; cwd?: string }> = [];
    const panelHost: CollabPanelHost = {
      register: () => () => {},
      open: (target) => { opened.push(target); },
    };

    openDshCollabRoom({ kind: "owned", roomId: "room-owned", hostSessionId: "session-owner", roomTitle: "Owned" }, panelHost);
    expect(opened).toEqual([{ sessionId: "session-owner" }]);

    openDshCollabRoom({ kind: "joined", roomId: "room-joined", gatewayEndpoint: "wss://alice.example/collab", roomTitle: "Joined" }, panelHost, {
      sessionId: "session-local", cwd: "C:/work/local",
    });
    expect(getDshCollabRoomSelection()).toMatchObject({ kind: "joined", localSessionId: "session-local" });
    expect(opened.at(-1)).toEqual({ sessionId: "session-local", cwd: "C:/work/local" });
    closeDshCollabRoom();
  });

  it("keeps room selection independent across DSH Sessions", () => {
    const panelHost: CollabPanelHost = { register: () => () => {}, open: () => {} };
    openDshCollabRoom({ kind: "owned", roomId: "room-a", hostSessionId: "session-a", roomTitle: "A" }, panelHost);
    openDshCollabRoom({ kind: "joined", roomId: "room-b", gatewayEndpoint: "wss://host.example/collab", roomTitle: "B" }, panelHost, { sessionId: "session-b" });

    expect(getDshCollabRoomSelection("session-a")).toMatchObject({ roomId: "room-a" });
    expect(getDshCollabRoomSelection("session-b")).toMatchObject({ roomId: "room-b" });

    closeDshCollabRoom("session-a");
    expect(getDshCollabRoomSelection("session-a")).toBeUndefined();
    expect(getDshCollabRoomSelection("session-b")).toMatchObject({ roomId: "room-b" });
    closeDshCollabRoom("session-b");
  });

  it("starts the Gateway only from an explicit share action before creating the Owner room", async () => {
    const actions = port();
    const order: string[] = [];
    actions.getGatewaySnapshot = () => ({ status: "stopped" });
    actions.startGateway = vi.fn(async () => { order.push("gateway"); return { status: "running" as const, port: 4310 }; });
    actions.shareHostRoom = vi.fn(async () => { order.push("room"); });

    await shareDshCollabOwnedRoom(actions, { roomId: "room-current", hostSessionId: "session-current", title: "Release planning" });

    expect(order).toEqual(["gateway", "room"]);
    expect(actions.shareHostRoom).toHaveBeenCalledWith({ roomId: "room-current", hostSessionId: "session-current", title: "Release planning" });

    order.length = 0;
    actions.getGatewaySnapshot = () => ({ status: "running", port: 4310 });
    await shareDshCollabOwnedRoom(actions, { roomId: "room-current", hostSessionId: "session-current", title: "Release planning" });
    expect(order).toEqual(["room"]);
  });

  it("creates invitations from the applied private-network endpoint", async () => {
    const actions = port();
    actions.getSnapshot = () => ({
      gatewayHost: "0.0.0.0", gatewayPort: 4311, exposeMode: "network", advertisedEndpoint: "ws://draft.example:4311/collab",
      appliedGateway: { gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "ws://192.168.1.20:4310/collab" },
    });
    actions.createInvite = vi.fn(async () => ({ invitation: "collab-invite" }));

    await expect(createDshCollabInvitation(actions, "room-owned")).resolves.toBe("collab-invite");
    expect(actions.createInvite).toHaveBeenCalledWith(expect.objectContaining({
      gatewayEndpoint: "ws://192.168.1.20:4310/collab",
      expiresAt: expect.any(Number),
    }), "room-owned");
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
      { gatewayEndpoint: "wss://alice.example/old-collab", roomId: "room-active", memberId: "member-bob", credential: "old-secret", roomTitle: "Active room" },
      { gatewayEndpoint: "wss://alice.example/collab", roomId: "room-active", memberId: "member-bob", credential: "active-secret", roomTitle: "Active room" },
      { gatewayEndpoint: "wss://bob.example/collab", roomId: "room-other", memberId: "member-bob", credential: "other-secret", roomTitle: "Other room" },
    ];
    activePort.getRoomSnapshot = () => ({ roomId: "room-active", gatewayEndpoint: "wss://alice.example/collab", roomTitle: "Active room", hostDisplayName: "Alice", role: "participant", connection: "online" });
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, { port: activePort }));
    setDshCollabRoomsOpen(false);

    expect(html).toContain("Disconnect");
    expect((html.match(/Connected/g) ?? []).length).toBe(1);
    expect((html.match(/Disconnected/g) ?? []).length).toBe(2);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect<\/button>/);
  });
});
