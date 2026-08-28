import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshotFile, WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { EventLedger } from "../../src/events.js";
import { ReviewPointService } from "../../src/review-points.js";
import { RoomStore } from "../../src/room.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function snapshot(snapshotId: string, roomEventSeq: number, files: Array<{ path: string; content: string }>): WorkspaceSnapshotPackage {
  const manifest: WorkspaceSnapshotFile[] = files.map((file) => ({ path: file.path, contentHash: hash(file.content), size: file.content.length, source: "tracked" }));
  return {
    snapshotId,
    roomId: "room-1",
    hostSessionId: "session-1",
    roomEventSeq,
    headOid: "a".repeat(40),
    manifestHash: hash(JSON.stringify(manifest)),
    files: manifest,
    createdAt: roomEventSeq + 10,
  };
}

function fixture() {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Release", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 2 });
  const ledger = new EventLedger();
  const snapshots = new Map<string, WorkspaceSnapshotPackage>();
  const service = new ReviewPointService({ rooms, ledger, snapshots: { load: async (snapshotId) => snapshots.get(snapshotId) }, now: () => 20 });
  return { rooms, ledger, snapshots, service };
}

describe("ReviewPointService", () => {
  it("keeps lifecycle, reviewed-file freshness and project progress independent", async () => {
    const { ledger, snapshots, service } = fixture();
    const original = snapshot("snapshot-1", 0, [{ path: "src/a.ts", content: "a1" }, { path: "src/b.ts", content: "b1" }]);
    const contextAdvanced = snapshot("snapshot-2", 1, [{ path: "src/a.ts", content: "a1" }, { path: "src/b.ts", content: "b2" }]);
    const stale = snapshot("snapshot-3", 2, [{ path: "src/a.ts", content: "a2" }, { path: "src/b.ts", content: "b2" }]);
    for (const value of [original, contextAdvanced, stale]) snapshots.set(value.snapshotId, value);

    const point = service.create({
      roomId: "room-1",
      principalId: "host",
      clientRequestId: "create-1",
      title: "Parser review",
      focus: "Error recovery",
      snapshot: original,
      files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
    });
    ledger.append({ eventId: "event-1", roomId: "room-1", type: "human.message", actor: { memberId: "member-bob", principalId: "bob" }, payload: { text: "continue" } });
    service.observeSnapshot({ roomId: "room-1", principalId: "host", snapshot: contextAdvanced });

    await expect(service.list({ roomId: "room-1", principalId: "bob" })).resolves.toEqual({
      reviewPoints: [{ reviewPoint: point, freshness: "current", progress: { roomEventDelta: 1, workspaceChangedFileCount: 1 } }],
    });

    service.observeSnapshot({ roomId: "room-1", principalId: "host", snapshot: stale });
    await expect(service.list({ roomId: "room-1", principalId: "bob" })).resolves.toMatchObject({
      reviewPoints: [{ reviewPoint: { lifecycle: "open" }, freshness: "stale", progress: { roomEventDelta: 1, workspaceChangedFileCount: 2 } }],
    });
  });

  it("restores immutable file anchors and idempotent creation after restart", async () => {
    const first = fixture();
    const original = snapshot("snapshot-1", 0, [{ path: "src/a.ts", content: "a1" }]);
    first.snapshots.set(original.snapshotId, original);
    const input = {
      roomId: "room-1",
      principalId: "host",
      clientRequestId: "create-1",
      title: "Parser review",
      snapshot: original,
      files: [{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 0 }],
    };
    const created = first.service.create(input);
    expect(first.service.create(input)).toEqual(created);

    const restored = ReviewPointService.fromSnapshot({
      rooms: first.rooms,
      ledger: first.ledger,
      snapshots: { load: async (snapshotId) => first.snapshots.get(snapshotId) },
      now: () => 30,
    }, first.service.snapshot());

    await expect(restored.list({ roomId: "room-1", principalId: "host" })).resolves.toMatchObject({
      reviewPoints: [{ reviewPoint: { reviewPointId: created.reviewPointId, files: [{ path: "src/a.ts", snapshotContentHash: hash("a1") }] }, freshness: "current" }],
    });
    expect(restored.create(input)).toEqual(created);
  });

  it("keeps a historical Review Point when the room is rebound to a new Host Session", async () => {
    const first = fixture();
    const original = snapshot("snapshot-1", 0, [{ path: "src/a.ts", content: "a1" }]);
    first.snapshots.set(original.snapshotId, original);
    const created = first.service.create({
      roomId: "room-1", principalId: "host", clientRequestId: "create-1", title: "Parser review", snapshot: original,
      files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    const reboundRooms = new RoomStore();
    reboundRooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-2", title: "Release", hostDisplayName: "Host", now: 1 });
    const current = { ...snapshot("snapshot-2", 1, [{ path: "src/a.ts", content: "a2" }]), hostSessionId: "session-2" };
    first.snapshots.set(current.snapshotId, current);

    const restored = ReviewPointService.fromSnapshot({
      rooms: reboundRooms,
      ledger: first.ledger,
      snapshots: { load: async (snapshotId) => first.snapshots.get(snapshotId) },
      now: () => 30,
    }, first.service.snapshot());
    restored.observeSnapshot({ roomId: "room-1", principalId: "host", snapshot: current });

    await expect(restored.list({ roomId: "room-1", principalId: "host" })).resolves.toMatchObject({
      reviewPoints: [{ reviewPoint: { reviewPointId: created.reviewPointId, mainAgentSessionId: "session-1" }, freshness: "stale" }],
    });
  });

  it("allows active members to read but only the Host to create or refresh", async () => {
    const { snapshots, service } = fixture();
    const original = snapshot("snapshot-1", 0, [{ path: "src/a.ts", content: "a1" }]);
    snapshots.set(original.snapshotId, original);
    const create = { roomId: "room-1", principalId: "bob", clientRequestId: "create-1", title: "Review", snapshot: original, files: [{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 0 }] };

    expect(() => service.create(create)).toThrow("Host");
    expect(() => service.observeSnapshot({ roomId: "room-1", principalId: "bob", snapshot: original })).toThrow("Host");
    await expect(service.list({ roomId: "room-1", principalId: "bob" })).resolves.toEqual({ reviewPoints: [] });
  });

  it("rejects malformed reviewer and file collections during restore", () => {
    const { rooms, ledger, service, snapshots } = fixture();
    const original = snapshot("snapshot-1", 0, [{ path: "src/a.ts", content: "a1" }]);
    snapshots.set(original.snapshotId, original);
    const point = service.create({
      roomId: "room-1", principalId: "host", clientRequestId: "create-1", title: "Parser review", snapshot: original,
      files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    const options = { rooms, ledger, snapshots: { load: async (snapshotId: string) => snapshots.get(snapshotId) } };
    const base = service.snapshot();

    expect(() => ReviewPointService.fromSnapshot(options, {
      ...base,
      reviewPoints: [{ ...point, reviewerIds: ["member-bob", "member-bob"] }],
    })).toThrow("invalid");
    expect(() => ReviewPointService.fromSnapshot(options, {
      ...base,
      reviewPoints: [{ ...point, files: [] }],
    })).toThrow("invalid");
  });
});
