import { describe, expect, it } from "vitest";
import {
  COLLAB_CAPABILITY_HEADER,
  COLLAB_PROTOCOL,
  CHANGE_SET_CAPABILITY,
  SIDECAR_REVIEW_CAPABILITY,
  WORKSPACE_VERSION_CAPABILITY,
  decodeCollaborationCapabilities,
  decodeClientStreamFrame,
  decodeServerStreamFrame,
  encodeCollaborationServerStreamFrame,
  encodeGatewayResponse,
  encodeClientStreamFrame,
  encodeServerStreamFrame,
} from "../../src/protocol.js";
import type { GatewayResponse, StreamFrame } from "../../src/types.js";

describe("dsh-collab wire protocol", () => {
  it("wraps successful gateway responses with a protocol and request id", () => {
    const response: GatewayResponse = { status: 200, body: { roomId: "room-1" } };

    expect(encodeGatewayResponse("req-1", response)).toEqual({
      protocol: COLLAB_PROTOCOL,
      requestId: "req-1",
      ok: true,
      data: { roomId: "room-1" },
    });
  });

  it("keeps structured gateway errors in the same response envelope", () => {
    const response: GatewayResponse = {
      status: 403,
      body: { error: { code: "ACTION_FORBIDDEN", message: "not allowed" } },
    };

    expect(encodeGatewayResponse("req-2", response)).toEqual({
      protocol: COLLAB_PROTOCOL,
      requestId: "req-2",
      ok: false,
      error: { code: "ACTION_FORBIDDEN", message: "not allowed" },
    });
  });

  it("maps internal stream frames to versioned server frames and back", () => {
    const frame: StreamFrame = {
      kind: "connected",
      connectionId: "conn-1",
      roomId: "room-1",
      lastEventSeq: 4,
    };

    const wire = encodeServerStreamFrame(frame);
    expect(wire).toEqual({
      protocol: COLLAB_PROTOCOL,
      type: "connected",
      connectionId: "conn-1",
      roomId: "room-1",
      lastEventSeq: 4,
    });
    expect(decodeServerStreamFrame(wire)).toEqual(frame);
  });

  it("accepts only known client stream control frames", () => {
    const heartbeat = { protocol: COLLAB_PROTOCOL, type: "heartbeat" } as const;
    expect(encodeClientStreamFrame(heartbeat)).toEqual(heartbeat);
    expect(decodeClientStreamFrame(heartbeat)).toEqual({
      protocol: COLLAB_PROTOCOL,
      type: "heartbeat",
    });
    expect(decodeClientStreamFrame({ protocol: COLLAB_PROTOCOL, type: "close" })).toEqual({
      protocol: COLLAB_PROTOCOL,
      type: "close",
    });
  });

  it("round-trips room presence frames", () => {
    const frame: StreamFrame = { kind: "presence", roomId: "room-1", onlineMemberCount: 2 };

    const wire = encodeServerStreamFrame(frame);

    expect(wire).toEqual({ protocol: COLLAB_PROTOCOL, type: "presence", roomId: "room-1", onlineMemberCount: 2 });
    expect(decodeServerStreamFrame(wire)).toEqual(frame);
  });

  it("accepts durable WorkspaceVersion events on the room stream", () => {
    const frame = {
      protocol: COLLAB_PROTOCOL,
      type: "event",
      event: {
        eventId: "workspace-version:version-1",
        roomId: "room-1",
        seq: 1,
        type: "workspace-version.published",
        actor: { memberId: "member-host", principalId: "host" },
        createdAt: 10,
        payload: {},
      },
    } as const;

    expect(decodeServerStreamFrame(frame)).toEqual({ kind: "event", event: frame.event });
  });

  it("round-trips transient accumulated Agent output", () => {
    const frame: StreamFrame = {
      kind: "agent-output",
      roomId: "room-1",
      requestId: "request-1",
      text: "partial **answer**",
      streaming: true,
    };

    const wire = encodeServerStreamFrame(frame);

    expect(wire).toEqual({
      protocol: COLLAB_PROTOCOL,
      type: "agent-output",
      roomId: "room-1",
      requestId: "request-1",
      text: "partial **answer**",
      streaming: true,
    });
    expect(decodeServerStreamFrame(wire)).toEqual(frame);
  });

  it("negotiates only known additive collaboration capabilities", () => {
    expect(COLLAB_CAPABILITY_HEADER).toBe("x-dsh-collab-capabilities");
    expect(decodeCollaborationCapabilities([
      SIDECAR_REVIEW_CAPABILITY,
      WORKSPACE_VERSION_CAPABILITY,
      CHANGE_SET_CAPABILITY,
      "future-capability.v9",
      SIDECAR_REVIEW_CAPABILITY,
    ])).toEqual([SIDECAR_REVIEW_CAPABILITY, WORKSPACE_VERSION_CAPABILITY, CHANGE_SET_CAPABILITY]);
    expect(decodeCollaborationCapabilities(`future.v9, ${SIDECAR_REVIEW_CAPABILITY}`)).toEqual([SIDECAR_REVIEW_CAPABILITY]);
    expect(decodeCollaborationCapabilities(undefined)).toEqual([]);
    expect(() => decodeCollaborationCapabilities([SIDECAR_REVIEW_CAPABILITY, 42])).toThrow("capability");
  });

  it("round-trips capability-gated workspace sharing events", () => {
    const frame = {
      kind: "collaboration-event",
      event: {
        type: "workspace-sharing.changed",
        state: {
          roomId: "room-1",
          enabled: true,
          enabledBy: "member-host",
          enabledAt: 100,
          revision: 1,
        },
      },
    } as const;

    const wire = encodeCollaborationServerStreamFrame(frame);

    expect(wire).toEqual({ protocol: COLLAB_PROTOCOL, type: "collaboration-event", event: frame.event });
    expect(decodeServerStreamFrame(wire)).toEqual(frame);
  });

  it("fails closed on malformed collaboration payloads", () => {
    expect(() => decodeServerStreamFrame({
      protocol: COLLAB_PROTOCOL,
      type: "collaboration-event",
      event: {
        type: "workspace-sharing.changed",
        state: { roomId: "room-1", enabled: true, revision: 1 },
      },
    })).toThrow("enabledBy");
    expect(() => decodeServerStreamFrame({
      protocol: COLLAB_PROTOCOL,
      type: "collaboration-event",
      event: { type: "future.event", state: {} },
    })).toThrow("event.type");
  });

  it("rejects unknown versions, frame types, and negative cursors", () => {
    expect(() => decodeClientStreamFrame({ protocol: "dsh-collab.v2", type: "heartbeat" })).toThrow("protocol");
    expect(() => decodeClientStreamFrame({ protocol: COLLAB_PROTOCOL, type: "event" })).toThrow("type");
    expect(() => decodeServerStreamFrame({
      protocol: COLLAB_PROTOCOL,
      type: "connected",
      connectionId: "conn-1",
      roomId: "room-1",
      lastEventSeq: -1,
    })).toThrow("lastEventSeq");
    expect(() => decodeServerStreamFrame({
      protocol: COLLAB_PROTOCOL,
      type: "event",
      event: {
        eventId: "event-1",
        roomId: "room-1",
        seq: 1,
        type: "future.event",
        actor: { memberId: "member-1", principalId: "principal-1" },
        createdAt: 1,
        payload: {},
      },
    })).toThrow("event.type");
    expect(() => decodeServerStreamFrame({
      protocol: COLLAB_PROTOCOL,
      type: "agent-output",
      roomId: "room-1",
      requestId: "request-1",
      text: "partial",
      streaming: "yes",
    })).toThrow("streaming");
  });
});
