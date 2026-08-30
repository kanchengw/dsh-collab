import { describe, expect, it, vi } from "vitest";
import { CollabGateway } from "../../src/gateway.js";
import { EventLedger } from "../../src/events.js";
import { InviteStore } from "../../src/invites.js";
import { projectRoomContext } from "../../src/room-context.js";
import { RoomStore } from "../../src/room.js";
import { WorkUpdateService } from "../../src/work-updates.js";

function setupRooms(): RoomStore {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "host",
    hostSessionId: "session-host",
    title: "Room",
    hostDisplayName: "Host",
    now: 1,
  });
  rooms.addMember("room-1", {
    memberId: "member-alice",
    principalId: "alice",
    displayName: "Alice",
    now: 2,
  });
  rooms.addMember("room-1", {
    memberId: "member-observer",
    principalId: "observer",
    displayName: "Observer",
    now: 3,
  });
  rooms.setMemberRole("room-1", "member-observer", "observer");
  return rooms;
}

function publishInput(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room-1",
    principalId: "alice",
    clientRequestId: "update-request-1",
    sourceSessionId: "session-alice",
    summary: "Implemented the parser recovery path.",
    filePaths: ["src/parser.ts", "tests/parser.test.ts"],
    ...overrides,
  };
}

describe("WorkUpdateService", () => {
  it("publishes an immutable durable update that enters Room Context", () => {
    const rooms = setupRooms();
    const ledger = new EventLedger();
    const service = new WorkUpdateService({ rooms, ledger, now: () => 100 });

    const result = service.publish(publishInput());

    expect(result.created).toBe(true);
    expect(result.update).toEqual({
      updateId: expect.stringMatching(/^[a-f0-9]{64}$/),
      roomId: "room-1",
      authorId: "member-alice",
      sourceSessionId: "session-alice",
      summary: "Implemented the parser recovery path.",
      filePaths: ["src/parser.ts", "tests/parser.test.ts"],
      createdAt: 100,
    });
    expect(result.event).toMatchObject({
      eventId: `work-update:${result.update.updateId}`,
      roomId: "room-1",
      seq: 1,
      type: "work-update.published",
      actor: { memberId: "member-alice", principalId: "alice" },
      payload: result.update,
    });
    expect(projectRoomContext({ roomId: "room-1", afterSeq: 0, events: [result.event], maxEntries: 10 })).toEqual({
      roomId: "room-1",
      fromSeq: 1,
      toSeq: 1,
      entries: [{
        kind: "work-update",
        author: "member-alice",
        summary: "Implemented the parser recovery path.",
        refs: ["src/parser.ts", "tests/parser.test.ts"],
      }],
      omittedCount: 0,
    });
  });

  it("returns the original update for an idempotent retry and conflicts on changed content", () => {
    const rooms = setupRooms();
    const ledger = new EventLedger();
    const service = new WorkUpdateService({ rooms, ledger, now: () => 100 });
    const first = service.publish(publishInput());

    expect(service.publish(publishInput())).toEqual({ ...first, created: false });
    expect(ledger.latestSeq("room-1")).toBe(1);
    expect(() => service.publish(publishInput({ summary: "Different content" }))).toThrow("conflicts");
  });

  it("restores its idempotency index from the Room Ledger snapshot", () => {
    const rooms = setupRooms();
    const ledger = new EventLedger();
    const first = new WorkUpdateService({ rooms, ledger, now: () => 100 }).publish(publishInput());
    const restoredRooms = RoomStore.fromSnapshot(rooms.snapshot());
    const restoredLedger = EventLedger.fromSnapshot(ledger.snapshot());

    const restored = new WorkUpdateService({ rooms: restoredRooms, ledger: restoredLedger, now: () => 999 });

    expect(restored.publish(publishInput())).toEqual({ ...first, created: false });
    expect(restoredLedger.latestSeq("room-1")).toBe(1);
  });

  it("rejects restored events with forged authority or private payload fields", () => {
    const rooms = setupRooms();
    const ledger = new EventLedger();
    new WorkUpdateService({ rooms, ledger, now: () => 100 }).publish(publishInput());
    const forgedAuthority = ledger.snapshot();
    forgedAuthority.rooms[0]!.events[0]!.actor.principalId = "mallory";
    const privatePayload = ledger.snapshot();
    (privatePayload.rooms[0]!.events[0]!.payload as Record<string, unknown>).transcript = "private transcript";

    expect(() => new WorkUpdateService({
      rooms: RoomStore.fromSnapshot(rooms.snapshot()),
      ledger: EventLedger.fromSnapshot(forgedAuthority),
    })).toThrow("snapshot");
    expect(() => new WorkUpdateService({
      rooms: RoomStore.fromSnapshot(rooms.snapshot()),
      ledger: EventLedger.fromSnapshot(privatePayload),
    })).toThrow("snapshot");
  });

  it("allows active contributors but rejects observer and inactive member publication", () => {
    const rooms = setupRooms();
    const ledger = new EventLedger();
    const service = new WorkUpdateService({ rooms, ledger });

    expect(() => service.publish(publishInput({ principalId: "observer" }))).toThrow("allowed");
    rooms.setMemberStatus("room-1", "member-alice", "suspended");
    expect(() => service.publish(publishInput())).toThrow("inactive");
    expect(ledger.latestSeq("room-1")).toBe(0);
  });

  it("rejects unsafe paths, oversized content, and unresolved or cross-room ChangeSet references", () => {
    const rooms = setupRooms();
    const ledger = new EventLedger();
    let resolvedRoom: string | undefined = "room-1";
    const service = new WorkUpdateService({
      rooms,
      ledger,
      resolveChangeSetRoom: (changeSetId) => changeSetId === "changeset-local" ? resolvedRoom : "room-2",
    });

    expect(() => service.publish(publishInput({ filePaths: ["../secret.env"] }))).toThrow("filePaths");
    expect(() => service.publish(publishInput({ summary: "x".repeat(10_001) }))).toThrow("summary");
    expect(() => service.publish(publishInput({ changeSetId: "changeset-foreign" }))).toThrow("ChangeSet");
    const local = service.publish(publishInput({ changeSetId: "changeset-local" }));
    expect(local.update.changeSetId).toBe("changeset-local");
    resolvedRoom = undefined;
    expect(service.publish(publishInput({ changeSetId: "changeset-local" }))).toEqual({ ...local, created: false });

    const withoutResolver = new WorkUpdateService({ rooms, ledger: new EventLedger() });
    expect(() => withoutResolver.publish(publishInput({ changeSetId: "changeset-local" }))).toThrow("ChangeSet");
  });

  it("constructs the durable payload from allowed fields instead of copying private extras", () => {
    const rooms = setupRooms();
    const ledger = new EventLedger();
    const service = new WorkUpdateService({ rooms, ledger });

    const result = service.publish(publishInput({
      transcript: "private Session transcript",
      toolLogs: ["secret tool output"],
      draft: "unpublished draft",
    }));

    expect(JSON.stringify(result)).not.toMatch(/private Session|secret tool|unpublished draft/);
  });
});

describe("Work Update Gateway endpoint", () => {
  async function gatewayHarness() {
    const rooms = setupRooms();
    const ledger = new EventLedger();
    const workUpdates = new WorkUpdateService({ rooms, ledger, now: () => 100 });
    const commitCriticalState = vi.fn(async () => {});
    const gateway = new CollabGateway({
      rooms,
      ledger,
      invites: new InviteStore(rooms),
      agent: { followup: () => {}, steer: () => {}, cancel: () => {} },
      workUpdates,
      commitCriticalState,
    });
    const bootstrap = await gateway.handle({
      method: "GET",
      path: "/v1/rooms/room-1/bootstrap",
      auth: { principalId: "alice" },
    });
    const token = (bootstrap.body as { roomToken: string }).roomToken;
    return { commitCriticalState, gateway, ledger, token };
  }

  it("publishes and durably commits an idempotent Work Update", async () => {
    const { commitCriticalState, gateway, ledger, token } = await gatewayHarness();
    const request = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/work-updates",
      headers: { authorization: `Bearer ${token}` },
      body: {
        clientRequestId: "update-request-1",
        sourceSessionId: "session-alice",
        summary: "Implemented the parser recovery path.",
        filePaths: ["src/parser.ts"],
      },
    };

    const first = await gateway.handle(request);
    const retry = await gateway.handle(request);

    expect(first).toMatchObject({ status: 201, body: { update: { authorId: "member-alice" }, event: { type: "work-update.published" } } });
    expect(retry).toEqual(first);
    expect(ledger.latestSeq("room-1")).toBe(1);
    expect(commitCriticalState).toHaveBeenCalledTimes(2);
  });

  it("rejects private or cross-room fields instead of silently ignoring them", async () => {
    const { gateway, ledger, token } = await gatewayHarness();
    const base = {
      clientRequestId: "update-request-1",
      sourceSessionId: "session-alice",
      summary: "Safe summary",
      filePaths: [],
    };

    const privateResponse = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/work-updates",
      headers: { authorization: `Bearer ${token}` },
      body: { ...base, transcript: "private transcript" },
    });
    const crossRoomResponse = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/work-updates",
      headers: { authorization: `Bearer ${token}` },
      body: { ...base, roomId: "room-2" },
    });

    expect(privateResponse.status).toBe(422);
    expect(crossRoomResponse.status).toBe(422);
    expect(ledger.latestSeq("room-1")).toBe(0);
  });
});
