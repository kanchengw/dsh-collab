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
