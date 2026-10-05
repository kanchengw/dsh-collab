import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { closeDshCollabRoom, createDshCollabInvitation, DshCollabRoomsLauncher, DshCollabRoomsPanel, getDshCollabRoomSelection, joinDshCollabRoom, openDshCollabOwnedRoom, openDshCollabRoom, setDshCollabRoomsOpen, shareDshCollabOwnedRoom } from "../../src/collab-rooms.js";
import type { DshCollabGatewayRuntimeSnapshot, DshCollabSettingsPort } from "../../src/dsh-client.js";
import type { CollabPanelHost } from "../../src/collab-panel-host.js";
import { encodeCollabInvitation } from "../../src/invitation.js";

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
    expect(html).toMatch(/name="displayName"[^>]*value="Participant"/);
    expect(html).toContain('data-collab-join-disclosure="true"');
    expect(html).toMatch(/<details open=""[^>]*data-collab-join-disclosure="true"/);
    expect(html).toContain("Join a room");
    expect(html).not.toContain("resume-secret");
    expect(html).not.toContain("Participating rooms");
  });

  it("shows the single-active-room boundary and blocks switching actions", () => {
    const actions = port();
    actions.getOwnedRooms = () => [
      { roomId: "room-active", hostSessionId: "session-active", title: "Active room", sharing: true },
      { roomId: "room-saved", hostSessionId: "session-saved", title: "Saved room", sharing: false },
    ];
    actions.getRoomSnapshot = () => ({ roomId: "room-active", roomTitle: "Active room", hostDisplayName: "Host", role: "host", connection: "online" });
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, { port: actions }));
    setDshCollabRoomsOpen(false);

    expect(html).toContain('data-collab-room-boundary="single-active-room"');
    expect(html).toContain("one Collab room at a time");
    expect(html).toMatch(/Saved room[\s\S]*Start sharing<\/button>/);
    expect(html).toContain('name="participantInvitation"');
    expect(html).toMatch(/name="participantInvitation"[^>]*disabled=""/);
  });

  it("does not show an owned room again in Joined rooms", () => {
    const actions = port();
    actions.listJoinedRooms = () => [{
      gatewayEndpoint: "ws://127.0.0.1:4310/collab",
      roomId: "room-owned",
      memberId: "member-stale",
      credential: "stale-secret",
      roomTitle: "Release planning",
    }];
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, { port: actions }));
    setDshCollabRoomsOpen(false);

    expect((html.match(/Release planning/g) ?? []).length).toBe(1);
    expect(html).toContain("Joined rooms");
  });

  it("offers Collab Workspace creation above the Owned rooms list", () => {
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, {
      port: port(),
      createOwnedRoom: vi.fn(),
      pickDirectory: vi.fn(),
    }));
    setDshCollabRoomsOpen(false);

    expect(html).toContain("Create a Collab workspace");
    expect(html).toContain("Choose directory");
    expect(html).toContain('name="ownedRoomTitle"');
    expect(html).toContain("Create Collab workspace");
    expect(html.indexOf("Create a Collab workspace")).toBeLessThan(html.indexOf("Owned rooms"));
  });

  it("does not bind a Joined room to the active unrelated Session", () => {
    setDshCollabRoomsOpen(true);
    const html = renderToStaticMarkup(createElement(DshCollabRoomsPanel, {
      port: port(),
      panelHost: { register: () => () => {}, open: vi.fn() },
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

  it("explains when the official Sidebar services are unavailable without hiding room management", () => {
    setDshCollabRoomsOpen(true);
    const missing = renderToStaticMarkup(createElement(DshCollabRoomsPanel, {
      port: port(),
    }));
    setDshCollabRoomsOpen(false);

    expect(missing).toContain("The official DSH Sidebar services are not ready");
    expect(missing).toContain("Owned rooms");
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
    actions.stopGateway = vi.fn(async () => { order.push("stop"); return { status: "stopped" as const }; });
    actions.startGateway = vi.fn(async () => { order.push("start"); return { status: "running" as const, port: 4310 }; });
    await shareDshCollabOwnedRoom(actions, { roomId: "room-current", hostSessionId: "session-current", title: "Release planning" });
    expect(order).toEqual(["stop", "start", "room"]);
  });

  it("restarts a running Gateway when its saved sharing configuration is stale", async () => {
    const actions = port();
    const order: string[] = [];
    actions.getGatewaySnapshot = () => ({ status: "running", port: 4310 });
    actions.getSnapshot = () => ({
      gatewayHost: "0.0.0.0", gatewayPort: 4311, exposeMode: "network", advertisedEndpoint: "",
      appliedGateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback", advertisedEndpoint: "" },
    });
    actions.stopGateway = vi.fn(async () => { order.push("stop"); return { status: "stopped" as const }; });
    actions.startGateway = vi.fn(async () => { order.push("start"); return { status: "running" as const, port: 4311 }; });
    actions.shareHostRoom = vi.fn(async () => { order.push("share"); });

    await shareDshCollabOwnedRoom(actions, { roomId: "room-current", hostSessionId: "session-current", title: "Release planning" });

    expect(order).toEqual(["stop", "start", "share"]);
  });

  it("refreshes the automatically detected private-network address before sharing", async () => {
    const actions = port();
    const order: string[] = [];
    actions.getSnapshot = () => ({
      gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "", connectionMethod: "private-network",
      appliedGateway: { gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "ws://192.168.0.65:4310/collab" },
    });
    actions.getGatewaySnapshot = () => ({ status: "running", port: 4310 });
    actions.stopGateway = vi.fn(async () => { order.push("stop"); return { status: "stopped" as const }; });
    actions.startGateway = vi.fn(async () => { order.push("start"); return { status: "running" as const, port: 4310 }; });
    actions.shareHostRoom = vi.fn(async () => { order.push("share"); });

    await shareDshCollabOwnedRoom(actions, { roomId: "room-current", hostSessionId: "session-current", title: "Release planning" });

    expect(order).toEqual(["stop", "start", "share"]);
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

  it("restarts a running private-network Gateway before creating an invitation after the address changes", async () => {
    const actions = port();
    let runtime: DshCollabGatewayRuntimeSnapshot = { status: "running", port: 4310, advertisedEndpoint: "ws://192.168.1.4:4310/collab" };
    const order: string[] = [];
    actions.getSnapshot = () => ({
      gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "ws://192.168.1.4:4310/collab",
      connectionMethod: "private-network",
      appliedGateway: { gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "ws://192.168.1.4:4310/collab" },
    });
    actions.getGatewaySnapshot = () => runtime;
    actions.stopGateway = vi.fn(async () => { order.push("stop"); runtime = { status: "stopped" }; return runtime; });
    actions.startGateway = vi.fn(async () => { order.push("start"); runtime = { status: "running", port: 4310, advertisedEndpoint: "ws://192.168.1.5:4310/collab" }; return runtime; });
    actions.createInvite = vi.fn(async () => ({ invitation: "refreshed-after-address-change" }));

    await expect(createDshCollabInvitation(actions, "room-owned")).resolves.toBe("refreshed-after-address-change");
    expect(order).toEqual(["stop", "start"]);
    expect(actions.createInvite).toHaveBeenCalledWith(expect.objectContaining({ gatewayEndpoint: "ws://192.168.1.5:4310/collab" }), "room-owned");
  });
  it("creates invitations from the running Gateway endpoint when settings are not shared with the renderer", async () => {
    const actions = port();
    actions.getSnapshot = () => ({
      gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "",
      connectionMethod: "private-network",
    });
    actions.getGatewaySnapshot = () => ({ status: "running", port: 4310, advertisedEndpoint: "ws://192.168.1.15:4310/collab" });
    actions.createInvite = vi.fn(async () => ({ invitation: "runtime-collab-invite" }));

    await expect(createDshCollabInvitation(actions, "room-owned")).resolves.toBe("runtime-collab-invite");
    expect(actions.createInvite).toHaveBeenCalledWith(expect.objectContaining({
      gatewayEndpoint: "ws://192.168.1.15:4310/collab",
      expiresAt: expect.any(Number),
    }), "room-owned");
  });

  it("refreshes a running Gateway before creating an invitation after renderer reload", async () => {
    const actions = port();
    let runtime: DshCollabGatewayRuntimeSnapshot = { status: "stopped" };
    actions.getSnapshot = () => ({
      gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "", connectionMethod: "private-network",
    });
    actions.getGatewaySnapshot = () => runtime;
    actions.refreshGateway = vi.fn(async () => {
      runtime = { status: "running", port: 4310, advertisedEndpoint: "ws://192.168.1.15:4310/collab" };
      return runtime;
    });
    actions.createInvite = vi.fn(async () => ({ invitation: "refreshed-runtime-collab-invite" }));

    await expect(createDshCollabInvitation(actions, "room-owned")).resolves.toBe("refreshed-runtime-collab-invite");
    expect(actions.refreshGateway).toHaveBeenCalledOnce();
    expect(actions.createInvite).toHaveBeenCalledWith(expect.objectContaining({
      gatewayEndpoint: "ws://192.168.1.15:4310/collab",
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

  it("opens the exact room that was just joined", async () => {
    const actions = port();
    const invitation = encodeCollabInvitation({
      protocol: "dsh-collab.invitation.v2",
      type: "invite",
      gatewayEndpoint: "ws://192.168.1.20/collab",
      roomId: "room-joined",
      inviteId: "invite-1",
      token: "token-1",
      expiresAt: Date.now() + 60_000,
      network: { mode: "lan", version: 1, endpoint: "ws://192.168.1.20/collab" },
    });
    actions.join = vi.fn(async () => {});
    actions.listJoinedRooms = () => [{
      gatewayEndpoint: "ws://192.168.1.20/collab",
      roomId: "room-joined",
      memberId: "member-bob",
      credential: "resume-secret",
      roomTitle: "Design review",
      hostDisplayName: "Alice",
    }];
    const openJoinedRoom = vi.fn(async () => {});

    await joinDshCollabRoom(actions, { invitation, displayName: "Bob" }, openJoinedRoom);

    expect(actions.join).toHaveBeenCalledWith({ invitation, displayName: "Bob" });
    expect(openJoinedRoom).toHaveBeenCalledWith({
      roomId: "room-joined",
      gatewayEndpoint: "ws://192.168.1.20/collab",
      roomTitle: "Design review",
      hostDisplayName: "Alice",
    });
  });
});
