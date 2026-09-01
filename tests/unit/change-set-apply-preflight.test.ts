import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ChangeSetApplyPreflightService,
  type ChangeSetApplyPreflightServiceSnapshot,
} from "../../src/change-set-apply.js";
import type { ChangeSetReview } from "../../src/change-set-reviews.js";
import type { StagedChangeSet } from "../../src/change-set-staging.js";
import { EventLedger } from "../../src/events.js";
import { RoomStore } from "../../src/room.js";

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const oldBytes = Buffer.from("old\n");
const changedBytes = Buffer.from("owner changed\n");
const resultBytes = Buffer.from("new\n");
const addedBytes = Buffer.from("added\n");
const patchBytes = Buffer.from("diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+new\n");
const changeSetId = "a".repeat(64);

function stagedChangeSet(): StagedChangeSet {
  return {
    version: 1,
    changeSetId,
    submittedAt: 20,
    draft: {
      version: 1,
      draftId: changeSetId,
      roomId: "room-1",
      authorId: "member-author",
      baseWorkspaceVersionId: "version-1",
      title: "Update workspace",
      summary: "Modify one file and add another.",
      files: [{
        path: "src/value.ts",
        operation: "modify",
        baseContentHash: hash(oldBytes),
        resultContentHash: hash(resultBytes),
        baseSize: oldBytes.byteLength,
        resultSize: resultBytes.byteLength,
        additions: 1,
        deletions: 1,
      }, {
        path: "src/added.ts",
        operation: "add",
        resultContentHash: hash(addedBytes),
        resultSize: addedBytes.byteLength,
        additions: 1,
        deletions: 0,
      }],
      artifact: {
        kind: "changeset-draft.v1",
        artifactId: changeSetId,
        manifestHash: changeSetId,
        patchHash: hash(patchBytes),
        patchBytes: patchBytes.byteLength,
        resultBytes: resultBytes.byteLength + addedBytes.byteLength,
      },
      createdAt: 10,
    },
  };
}

function approvedReview(overrides: Partial<ChangeSetReview> = {}): ChangeSetReview {
  return {
    version: 1,
    roomId: "room-1",
    changeSetId,
    authorId: "member-author",
    status: "approved",
    requiredReviewerId: "member-reviewer",
    decision: {
      decisionId: "c".repeat(64),
      roomId: "room-1",
      changeSetId,
      reviewerId: "member-reviewer",
      outcome: "approved",
      createdAt: 30,
    },
    assignmentCount: 1,
    findingCount: 0,
    ...overrides,
  };
}

function setup(input: {
  changeSet?: StagedChangeSet;
  review?: ChangeSetReview;
  current?: ReadonlyMap<string, Uint8Array>;
  results?: ReadonlyMap<string, Uint8Array>;
  patch?: Uint8Array;
  snapshot?: ChangeSetApplyPreflightServiceSnapshot;
  ledgerSnapshot?: ReturnType<EventLedger["snapshot"]>;
} = {}) {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "principal-host",
    hostSessionId: "session-1",
    title: "Room 1",
    hostDisplayName: "Host",
    now: 1,
  });
  rooms.addMember("room-1", { memberId: "member-author", principalId: "principal-author", displayName: "Author", now: 2 });
  rooms.addMember("room-1", { memberId: "member-reviewer", principalId: "principal-reviewer", displayName: "Reviewer", now: 3 });
  const changeSet = input.changeSet ?? stagedChangeSet();
  const review = input.review ?? approvedReview();
  const current = input.current ?? new Map([["src/value.ts", oldBytes]]);
  const results = input.results ?? new Map([["src/value.ts", resultBytes], ["src/added.ts", addedBytes]]);
  const inspect = vi.fn(async (_roomId: string, path: string) => {
    const bytes = current.get(path);
    return bytes ? { contentHash: hash(bytes), size: bytes.byteLength } : undefined;
  });
  let now = 100;
  const ledger = input.ledgerSnapshot ? EventLedger.fromSnapshot(input.ledgerSnapshot) : new EventLedger();
  const options = {
    rooms,
    ledger,
    changeSets: {
      get: async (roomId: string, id: string) => roomId === changeSet.draft.roomId && id === changeSet.changeSetId ? structuredClone(changeSet) : undefined,
      readPatch: async () => structuredClone(input.patch ?? patchBytes),
      readResult: async (_roomId: string, _id: string, path: string) => {
        const bytes = results.get(path);
        if (!bytes) throw new Error("missing result");
        return structuredClone(bytes);
      },
    },
    reviews: {
      getReview: async () => structuredClone(review),
    },
    workspace: { inspect },
    now: () => now++,
  };
  const service = input.snapshot
    ? ChangeSetApplyPreflightService.fromSnapshot(options, input.snapshot)
    : new ChangeSetApplyPreflightService(options);
  return { inspect, ledger, options, rooms, service };
}

describe("ChangeSet apply preflight", () => {
  it("returns one fully verified read-only plan for an approved ChangeSet", async () => {
    const { service } = setup();

    const result = await service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId });

    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") throw new Error("expected a ready plan");
    expect(result.plan).toMatchObject({ roomId: "room-1", changeSetId, baseWorkspaceVersionId: "version-1" });
    expect(result.plan.patch).toEqual(new Uint8Array(patchBytes));
    expect(result.plan.operations.map((operation) => operation.operation)).toEqual(["modify", "add"]);
    expect(result.plan.operations[0]!.result?.bytes).toEqual(new Uint8Array(resultBytes));
    expect(result.plan.operations[1]!.result?.bytes).toEqual(new Uint8Array(addedBytes));
    expect(service.snapshot().conflicts).toEqual([]);
  });

  it("rejects a non-Owner or a ChangeSet that is not approved", async () => {
    const { service } = setup();
    await expect(service.preflight({ roomId: "room-1", principalId: "principal-author", changeSetId }))
      .rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });

    const unapproved = setup({ review: approvedReview({ status: "changes-requested", decision: { ...approvedReview().decision!, outcome: "changes-requested" } }) });
    await expect(unapproved.service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId }))
      .rejects.toMatchObject({ code: "REQUEST_STATE" });
  });

  it("reports every stale base or occupied target before any write phase exists", async () => {
    const current = new Map<string, Uint8Array>([
      ["src/value.ts", changedBytes],
      ["src/added.ts", Buffer.from("already here\n")],
    ]);
    const { service } = setup({ current });

    const result = await service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId });

    expect(result).toMatchObject({
      outcome: "conflicted",
      conflict: {
        conflicts: [
          { path: "src/value.ts", kind: "base-changed", expectedContentHash: hash(oldBytes), actualContentHash: hash(changedBytes) },
          { path: "src/added.ts", kind: "target-exists", actualContentHash: hash(Buffer.from("already here\n")) },
        ],
      },
    });
  });

  it("rejects missing, extra, or tampered durable conflict events during restore", async () => {
    const current = new Map<string, Uint8Array>([["src/value.ts", changedBytes]]);
    const runtime = setup({ current });
    const result = await runtime.service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId });
    if (result.outcome !== "conflicted") throw new Error("expected a conflict");
    const domain = runtime.service.snapshot();
    const authority = runtime.ledger.snapshot();
    const restore = (candidate: typeof authority) => ChangeSetApplyPreflightService.fromSnapshot({
      ...runtime.options,
      ledger: EventLedger.fromSnapshot(candidate),
    }, domain);

    const missing = structuredClone(authority);
    missing.rooms[0]!.events = [];
    expect(() => restore(missing)).toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));

    const extraLedger = EventLedger.fromSnapshot(authority);
    extraLedger.append({
      eventId: `changeset-apply-conflicted:${"9".repeat(64)}`,
      roomId: "room-1",
      type: "changeset.apply-conflicted",
      actor: { memberId: "member-host", principalId: "principal-host" },
      createdAt: 999,
      payload: { ...result.conflict, conflictId: "9".repeat(64), createdAt: 999 },
    });
    expect(() => ChangeSetApplyPreflightService.fromSnapshot({ ...runtime.options, ledger: extraLedger }, domain))
      .toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));

    for (const mutate of [
      (event: typeof authority.rooms[number]["events"][number]) => { event.actor.principalId = "principal-author"; },
      (event: typeof authority.rooms[number]["events"][number]) => { event.createdAt += 1; },
      (event: typeof authority.rooms[number]["events"][number]) => { event.payload = { forged: true }; },
    ]) {
      const tampered = structuredClone(authority);
      mutate(tampered.rooms[0]!.events[0]!);
      expect(() => restore(tampered)).toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
    }
  });

  it("plans delete and rename from their original paths while protecting the rename target", async () => {
    const deleteBytes = Buffer.from("delete me\n");
    const renameBytes = Buffer.from("rename me\n");
    const changeSet = stagedChangeSet();
    changeSet.draft.files = [{
      path: "src/delete.ts",
      operation: "delete",
      baseContentHash: hash(deleteBytes),
      baseSize: deleteBytes.byteLength,
      additions: 0,
      deletions: 1,
    }, {
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      operation: "rename",
      baseContentHash: hash(renameBytes),
      resultContentHash: hash(renameBytes),
      baseSize: renameBytes.byteLength,
      resultSize: renameBytes.byteLength,
      additions: 0,
      deletions: 0,
    }];
    const state = setup({
      changeSet,
      current: new Map([["src/delete.ts", deleteBytes], ["src/old-name.ts", renameBytes]]),
      results: new Map([["src/new-name.ts", renameBytes]]),
    });

    const result = await state.service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId });
    expect(result).toMatchObject({
      outcome: "ready",
      plan: {
        operations: [
          { path: "src/delete.ts", operation: "delete", base: { path: "src/delete.ts" } },
          { path: "src/new-name.ts", previousPath: "src/old-name.ts", operation: "rename", base: { path: "src/old-name.ts" } },
        ],
      },
    });
  });

  it("fails closed on unsafe paths or corrupted result content", async () => {
    const unsafe = stagedChangeSet();
    unsafe.draft.files[0]!.path = "../escape.ts";
    const unsafeState = setup({ changeSet: unsafe });
    await expect(unsafeState.service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId }))
      .rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    expect(unsafeState.inspect).not.toHaveBeenCalled();

    const malformed = stagedChangeSet();
    malformed.draft.files[1] = { ...malformed.draft.files[1]!, baseContentHash: "not-a-hash", baseSize: 1 };
    const malformedState = setup({ changeSet: malformed });
    await expect(malformedState.service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId }))
      .rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    expect(malformedState.inspect).not.toHaveBeenCalled();

    const malformedEnvelope = { ...stagedChangeSet(), version: 2 as 1 };
    await expect(setup({ changeSet: malformedEnvelope }).service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId }))
      .rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });

    const corrupted = setup({ results: new Map([["src/value.ts", Buffer.from("tampered\n")], ["src/added.ts", addedBytes]]) });
    await expect(corrupted.service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId }))
      .rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    expect(corrupted.service.snapshot().conflicts).toEqual([]);

    const corruptedPatch = setup({ patch: Buffer.from("tampered patch\n") });
    await expect(corruptedPatch.service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId }))
      .rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
  });

  it("persists one deterministic conflict record and appends one durable event on an exact retry", async () => {
    const state = setup({ current: new Map([["src/value.ts", changedBytes]]) });

    const first = await state.service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId });
    const repeated = await state.service.preflight({ roomId: "room-1", principalId: "principal-host", changeSetId });
    expect(repeated).toEqual(first);
    expect(state.ledger.readAfter("room-1", 0)).toEqual([expect.objectContaining({
      type: "changeset.apply-conflicted",
      actor: { memberId: "member-host", principalId: "principal-host" },
      payload: expect.objectContaining({ conflictId: state.service.snapshot().conflicts[0]!.conflictId }),
    })]);

    const snapshot = state.service.snapshot();
    const restored = setup({
      current: new Map([["src/value.ts", changedBytes]]),
      snapshot,
      ledgerSnapshot: state.ledger.snapshot(),
    }).service;
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.listConflicts("room-1", changeSetId)).toEqual(snapshot.conflicts);

    const corrupted = structuredClone(snapshot);
    corrupted.conflicts[0]!.detectedBy = "unknown-member";
    expect(() => setup({ current: new Map([["src/value.ts", changedBytes]]), snapshot: corrupted }))
      .toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
  });
});
