import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { createDshCollabHostRuntime } from "../../src/host-runtime.js";
import { COLLAB_CAPABILITY_HEADER, SIDECAR_REVIEW_CAPABILITY } from "../../src/protocol.js";

const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

describe("Human Review API", () => {
  it("persists member findings, reviewer assignment and Host-only decisions", async () => {
    const content = Buffer.from("line 1\nline 2\n");
    const files = [{ path: "src/parser.ts", contentHash: hash(content), size: content.byteLength, source: "tracked" as const }];
    const snapshot: WorkspaceSnapshotPackage = {
      snapshotId: "snapshot-1", roomId: "room-1", hostSessionId: "room-1", roomEventSeq: 0,
      headOid: "a".repeat(40), manifestHash: hash(JSON.stringify(files)), files, createdAt: 10,
    };
    const provider = {
      capture: async () => snapshot,
      load: async (snapshotId: string) => snapshotId === snapshot.snapshotId ? snapshot : undefined,
      readChunk: async (_snapshotId: string, _path: string, offset: number, length: number) => content.subarray(offset, offset + length),
    };
    const options = {
      roomId: "room-1", hostId: "host", hostSessionId: "room-1", title: "Release", hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} }, workspaceSnapshots: provider, now: () => 30,
    };
    const first = createDshCollabHostRuntime(options);
    first.rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 2 });
    const point = first.reviewPoints.create({
      roomId: "room-1", principalId: "host", clientRequestId: "point-1", title: "Parser review", snapshot,
      files: [{ path: "src/parser.ts", status: "modified", additions: 2, deletions: 1 }],
      diffs: [{ path: "src/parser.ts", kind: "text", oldText: "line 1\n", newText: "line 1\nline 2\n" }],
    });
    const host = await first.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const bob = await first.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "bob" } });
    const headers = (token: string) => ({ authorization: `Bearer ${token}`, [COLLAB_CAPABILITY_HEADER]: SIDECAR_REVIEW_CAPABILITY });
    const hostHeaders = headers((host.body as { roomToken: string }).roomToken);
    const bobHeaders = headers((bob.body as { roomToken: string }).roomToken);

    const created = await first.gateway.handle({
      method: "POST", path: `/v1/rooms/room-1/review-points/${point.reviewPointId}/findings`, headers: bobHeaders,
      body: { clientRequestId: "finding-1", severity: "high", location: { kind: "line", path: "src/parser.ts", line: 2 }, body: "Recovery skips the token." },
    });
    expect(created).toMatchObject({ status: 201, body: { finding: { authorId: "member-bob", state: "open" } } });
    const findingId = (created.body as { finding: { findingId: string } }).finding.findingId;
    expect(await first.gateway.handle({ method: "GET", path: `/v1/rooms/room-1/review-points/${point.reviewPointId}/findings`, headers: bobHeaders }))
      .toMatchObject({ status: 200, body: { findings: [{ findingId }] } });
    expect(await first.gateway.handle({ method: "PUT", path: `/v1/rooms/room-1/review-points/${point.reviewPointId}/findings/${findingId}/state`, headers: bobHeaders, body: { state: "accepted" } }))
      .toMatchObject({ status: 403 });
    expect(await first.gateway.handle({ method: "PUT", path: `/v1/rooms/room-1/review-points/${point.reviewPointId}/reviewers`, headers: hostHeaders, body: { reviewerIds: ["member-bob"] } }))
      .toMatchObject({ status: 200, body: { reviewPoint: { reviewerIds: ["member-bob"] } } });
    expect(await first.gateway.handle({ method: "PUT", path: `/v1/rooms/room-1/review-points/${point.reviewPointId}/lifecycle`, headers: hostHeaders, body: { lifecycle: "changes-requested" } }))
      .toMatchObject({ status: 200, body: { reviewPoint: { lifecycle: "changes-requested" } } });
    expect(await first.gateway.handle({ method: "PUT", path: `/v1/rooms/room-1/review-points/${point.reviewPointId}/findings/${findingId}/state`, headers: hostHeaders, body: { state: "accepted" } }))
      .toMatchObject({ status: 200, body: { finding: { state: "accepted" } } });

    const persisted = first.snapshot();
    await first.dispose();
    const restored = createDshCollabHostRuntime({ ...options, snapshot: persisted });
    expect(await restored.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/host", auth: { principalId: "host" }, body: { hostSessionId: "room-1", title: "Release" } })).toMatchObject({ status: 200 });
    const restoredBob = await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "bob" } });
    const restoredHeaders = headers((restoredBob.body as { roomToken: string }).roomToken);
    expect(await restored.gateway.handle({ method: "GET", path: `/v1/rooms/room-1/review-points/${point.reviewPointId}/findings`, headers: restoredHeaders }))
      .toMatchObject({ status: 200, body: { findings: [{ findingId, state: "accepted" }] } });
    await restored.dispose();
  });
});
