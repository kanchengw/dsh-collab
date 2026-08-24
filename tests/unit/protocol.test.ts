import { describe, expect, it } from "vitest";
import {
  COLLAB_PROTOCOL,
  decodeClientStreamFrame,
  decodeServerStreamFrame,
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
  });
});
