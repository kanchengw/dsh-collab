import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayWorkUpdatePublisher, bindCollabPublishUpdateTool, type DshCollabScopedAgent, type DshCollabToolDefinition } from "../../src/dsh-collab-tools.js";
import { EventLedger } from "../../src/events.js";
import { CollabGateway } from "../../src/gateway.js";
import { InviteStore } from "../../src/invites.js";
import type { ParticipantGatewayTransport } from "../../src/participant.js";
import { projectRoomContext } from "../../src/room-context.js";
import { RoomProjectStore } from "../../src/room-projects.js";
import { RoomStore } from "../../src/room.js";
import { WorkUpdateService } from "../../src/work-updates.js";

describe("Work Update native tool vertical slice", () => {
  it("publishes through the Gateway without touching the Room Agent and enters the next member Snapshot", async () => {
    const rooms = new RoomStore();
    rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Room", hostDisplayName: "Host", now: 1 });
    rooms.addMember("room-1", { memberId: "member-alice", principalId: "alice", displayName: "Alice", now: 2 });
    const ledger = new EventLedger();
    const followup = vi.fn();
    const gateway = new CollabGateway({
      rooms,
      ledger,
      invites: new InviteStore(rooms),
      agent: { followup, steer: vi.fn(), cancel: vi.fn() },
      workUpdates: new WorkUpdateService({ rooms, ledger, now: () => 100 }),
    });
    const bootstrap = await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "alice" } });
    const token = (bootstrap.body as { roomToken: string }).roomToken;
    const transport: ParticipantGatewayTransport = {
      request: async (input) => await gateway.handle({
        method: input.method,
        path: input.path,
        headers: { authorization: `Bearer ${input.token}` },
        body: input.body,
      }),
    };
    let definition: DshCollabToolDefinition | undefined;
    const nativeAgent: DshCollabScopedAgent = {
      id: "session-alice",
      session: { header: { cwd: resolve("workspace") } },
      ctx: {
        tools: { register: (value) => { definition = value; return () => {}; } },
        on: () => () => {},
      },
    };
    const projects = new RoomProjectStore();
    projects.register({ roomId: "room-1", memberId: "member-alice", roomTitle: "Room", workspacePath: nativeAgent.session!.header!.cwd! });
    bindCollabPublishUpdateTool({
      agents: new Map([["session-alice", nativeAgent]]),
      projects,
      sessionId: "session-alice",
      publisher: new GatewayWorkUpdatePublisher({ transport, tokenForRoom: () => token }),
    });

    await definition!.execute({ summary: "Recovered the parser.", filePaths: ["src/parser.ts"] }, { callId: "tool-call-1", signal: new AbortController().signal });
    await definition!.execute({ summary: "Recovered the parser.", filePaths: ["src/parser.ts"] }, { callId: "tool-call-1", signal: new AbortController().signal });

    expect(followup).not.toHaveBeenCalled();
    expect(ledger.snapshot().rooms[0]?.events).toHaveLength(1);
    expect(projectRoomContext({ roomId: "room-1", afterSeq: 0, events: ledger.snapshot().rooms[0]!.events, maxEntries: 10 })).toEqual({
      roomId: "room-1",
      fromSeq: 1,
      toSeq: 1,
      entries: [{ kind: "work-update", author: "member-alice", summary: "Recovered the parser.", refs: ["src/parser.ts"] }],
      omittedCount: 0,
    });
  });
});
