import { describe, expect, it } from "vitest";
import { exportAudit, redactSensitive } from "../../src/audit.js";
import { EventLedger } from "../../src/events.js";
import { RoomStore } from "../../src/room.js";

function room() {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Release", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-alice", principalId: "alice", displayName: "Alice", now: 2 });
  return rooms;
}

describe("audit export", () => {
  it("recursively redacts tokens, paths, environment variables, and tool arguments", () => {
    const input = {
      token: "room-secret",
      nested: { filePath: "C:\\private\\release.sh", env: { API_KEY: "secret" }, toolArgs: { command: "cat secret.txt" } },
      safe: "visible",
    };
    const redacted = redactSensitive(input);
    expect(redacted).toEqual({
      token: "[REDACTED]",
      nested: { filePath: "[REDACTED]", env: "[REDACTED]", toolArgs: "[REDACTED]" },
      safe: "visible",
    });
    expect(input.nested.env.API_KEY).toBe("secret");
  });

  it("exports a sanitized ledger only for the Host", () => {
    const rooms = room();
    const ledger = new EventLedger();
    ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "agent.state.changed",
      actor: { memberId: "member-host", principalId: "host" },
      createdAt: 3,
      payload: { tool: "bash", path: "/private/release.sh", authorization: "Bearer secret" },
    });
    const exported = exportAudit({ rooms, ledger, roomId: "room-1", principalId: "host" });
    expect(exported.events[0]?.payload).toEqual({ tool: "bash", path: "[REDACTED]", authorization: "[REDACTED]" });
    expect(() => exportAudit({ rooms, ledger, roomId: "room-1", principalId: "alice" })).toThrow("not allowed");
  });
});
