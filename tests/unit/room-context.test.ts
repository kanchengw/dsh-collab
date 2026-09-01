import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CollabError } from "../../src/errors.js";
import { projectRoomContext } from "../../src/room-context.js";
import type { RoomEvent, RoomEventType } from "../../src/types.js";

function event(
  seq: number,
  type: RoomEventType,
  payload: unknown,
  overrides: Partial<RoomEvent> = {},
): RoomEvent {
  return {
    eventId: `event-${seq}`,
    roomId: "room-1",
    seq,
    type,
    actor: { memberId: "member-alice", principalId: "alice" },
    createdAt: 1_000 + seq,
    payload,
    ...overrides,
  };
}

function message(seq: number, text: string, overrides: Partial<RoomEvent> = {}): RoomEvent {
  return event(seq, "human.message", {
    kind: "human",
    messageId: `message-${seq}`,
    roomId: "room-1",
    authorMemberId: "member-alice",
    text,
    visibility: "room",
  }, overrides);
}

function expectInvalid(action: () => unknown): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CollabError);
  expect(thrown).toMatchObject({ code: "INVALID_INPUT" });
}

describe("projectRoomContext", () => {
  it("projects a contiguous durable interval into deterministic message entries", () => {
    const input = {
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 10,
      events: [message(1, "first"), message(2, "second")],
    };

    expect(projectRoomContext(input)).toEqual({
      roomId: "room-1",
      fromSeq: 1,
      toSeq: 2,
      entries: [
        { kind: "message", author: "member-alice", text: "first" },
        { kind: "message", author: "member-alice", text: "second" },
      ],
      omittedCount: 0,
    });
    expect(JSON.stringify(projectRoomContext(input))).toBe(JSON.stringify(projectRoomContext(input)));
  });

  it("returns undefined when there is no durable interval to consume", () => {
    expect(projectRoomContext({
      roomId: "room-1",
      afterSeq: 4,
      maxEntries: 10,
      events: [],
    })).toBeUndefined();
  });

  it("rejects an interval that does not begin after the supplied cursor", () => {
    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: 4,
      maxEntries: 10,
      events: [message(6, "late")],
    }));
  });

  it("rejects an internal sequence gap or duplicate", () => {
    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 10,
      events: [message(1, "first"), message(3, "third")],
    }));
    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 10,
      events: [message(1, "first"), message(1, "duplicate")],
    }));
  });

  it("rejects an event outside the requested room", () => {
    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 10,
      events: [message(1, "wrong room", { roomId: "room-2" })],
    }));
  });

  it("rejects a message whose room visibility or durable author does not match", () => {
    const privatePayload = {
      kind: "human",
      messageId: "message-1",
      roomId: "room-1",
      authorMemberId: "member-alice",
      text: "private",
      visibility: "private",
    };
    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 10,
      events: [event(1, "human.message", privatePayload)],
    }));

    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 10,
      events: [message(1, "spoofed", { actor: { memberId: "member-bob", principalId: "bob" } })],
    }));
  });

  it("rejects a malformed durable human message", () => {
    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 10,
      events: [event(1, "human.message", { text: "missing durable envelope" })],
    }));
  });

  it("filters lifecycle events while advancing across their durable range", () => {
    const snapshot = projectRoomContext({
      roomId: "room-1",
      afterSeq: 8,
      maxEntries: 10,
      events: [
        event(9, "member.joined", { memberId: "member-bob" }),
        event(10, "agent.request.queued", { requestId: "request-1" }),
        event(11, "approval.decided", { requestId: "request-1" }),
      ],
    });

    expect(snapshot).toEqual({
      roomId: "room-1",
      fromSeq: 9,
      toSeq: 11,
      entries: [],
      omittedCount: 0,
    });
  });

  it("tracks the latest durable Workspace Version without spending an entry slot", () => {
    const files: never[] = [];
    const workspaceVersionId = "workspace-version-1";
    const snapshot = projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 1,
      events: [
        message(1, "before publish"),
        event(2, "workspace-version.published", {
          version: { workspaceVersionId, roomId: "room-1", files, createdBy: "member-host", createdAt: 1_002 },
          manifestHash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
          artifact: { kind: "workspace-snapshot.v1", snapshotId: workspaceVersionId, manifestHash: "a".repeat(64), totalBytes: 0 },
        }, { actor: { memberId: "member-host", principalId: "host" } }),
        message(3, "after publish"),
      ],
    });

    expect(snapshot).toEqual({
      roomId: "room-1",
      fromSeq: 1,
      toSeq: 3,
      workspaceVersionId,
      entries: [{ kind: "message", author: "member-alice", text: "after publish" }],
      omittedCount: 1,
    });
  });

  it("projects durable ChangeSet and Review collaboration into Agent context", () => {
    const changeSetId = "a".repeat(64);
    const snapshot = projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 10,
      events: [
        event(1, "changeset.submitted", {
          changeSetId,
          authorId: "member-alice",
          title: "Fix reconnect",
          summary: "Keep room state after reconnect.",
          submittedAt: 1_001,
        }),
        event(2, "changeset.review-assigned", {
          assignmentId: "b".repeat(64),
          changeSetId,
          assignedBy: "member-alice",
          reviewerId: "member-reviewer",
          createdAt: 1_002,
        }),
        event(3, "changeset.finding-created", {
          findingId: "c".repeat(64),
          changeSetId,
          authorId: "member-alice",
          severity: "high",
          location: { kind: "file", path: "src/reconnect.ts" },
          body: "Reconnect can race.",
          createdAt: 1_003,
        }),
        event(4, "changeset.review-decided", {
          decisionId: "d".repeat(64),
          changeSetId,
          reviewerId: "member-alice",
          outcome: "changes-requested",
          note: "Add an ordering guard.",
          createdAt: 1_004,
        }),
        event(5, "changeset.revision-linked", {
          revisionLinkId: "e".repeat(64),
          changeSetId: "f".repeat(64),
          supersedesChangeSetId: changeSetId,
          linkedBy: "member-alice",
          createdAt: 1_005,
        }),
        event(6, "changeset.applied", {
          version: 1,
          applicationId: "f".repeat(64),
          roomId: "room-1",
          changeSetId,
          appliedBy: "member-alice",
          workspaceVersionId: "workspace-version-2",
          integrationId: "integration-1",
          createdAt: 1_006,
        }),
        event(7, "changeset.apply-conflicted", {
          version: 1,
          conflictId: "9".repeat(64),
          roomId: "room-1",
          changeSetId,
          baseWorkspaceVersionId: "workspace-version-1",
          detectedBy: "member-alice",
          conflicts: [{ path: "src/reconnect.ts", kind: "base-changed" }],
          createdAt: 1_007,
        }),
        event(8, "workspace-sharing.changed", { roomId: "room-1", enabled: false, revision: 2 }),
      ],
    });

    expect(snapshot).toEqual({
      roomId: "room-1",
      fromSeq: 1,
      toSeq: 8,
      entries: [
        { kind: "changeset", changeSetId, author: "member-alice", status: "submitted", summary: "Fix reconnect: Keep room state after reconnect." },
        { kind: "review", changeSetId, author: "member-alice", decision: "Assigned reviewer member-reviewer" },
        { kind: "review", changeSetId, author: "member-alice", decision: "[high] Reconnect can race." },
        { kind: "review", changeSetId, author: "member-alice", decision: "changes-requested: Add an ordering guard." },
        { kind: "changeset", changeSetId: "f".repeat(64), author: "member-alice", status: "revision", summary: `Supersedes ${changeSetId}` },
        { kind: "changeset", changeSetId, author: "member-alice", status: "applied", summary: "Workspace workspace-version-2" },
        { kind: "changeset", changeSetId, author: "member-alice", status: "conflicted", summary: "Conflicts: src/reconnect.ts" },
      ],
      omittedCount: 0,
    });
  });

  it("rejects a collaboration payload whose actor does not match its domain author", () => {
    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 10,
      events: [event(1, "changeset.review-decided", {
        decisionId: "d".repeat(64),
        changeSetId: "a".repeat(64),
        reviewerId: "member-reviewer",
        outcome: "approved",
        createdAt: 1_001,
      })],
    }));
  });

  it("keeps the newest eligible entries and counts only budget omissions", () => {
    const snapshot = projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 2,
      events: [
        message(1, "oldest"),
        event(2, "agent.state.changed", { state: "busy" }),
        message(3, "middle"),
        message(4, "newest"),
      ],
    });

    expect(snapshot).toEqual({
      roomId: "room-1",
      fromSeq: 1,
      toSeq: 4,
      entries: [
        { kind: "message", author: "member-alice", text: "middle" },
        { kind: "message", author: "member-alice", text: "newest" },
      ],
      omittedCount: 1,
    });
  });

  it("rejects invalid cursors and budgets at the projector boundary", () => {
    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: -1,
      maxEntries: 10,
      events: [],
    }));
    expectInvalid(() => projectRoomContext({
      roomId: "room-1",
      afterSeq: 0,
      maxEntries: 0,
      events: [],
    }));
  });
});
