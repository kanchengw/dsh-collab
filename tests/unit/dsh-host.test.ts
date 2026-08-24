import { describe, expect, it, vi } from "vitest";
import { createDshHostAgentPort, registerDshCollabHost, type DshSessionService } from "../../src/dsh-host.js";

function webServerStub() {
  const http: string[] = [];
  const upgrades: string[] = [];
  return {
    http,
    upgrades,
    webServer: {
      register: vi.fn(({ path }: { path: string }) => { http.push(path); return () => http.splice(http.indexOf(path), 1); }),
      registerUpgrade: vi.fn(({ path }: { path: string }) => { upgrades.push(path); return () => upgrades.splice(upgrades.indexOf(path), 1); }),
    },
  };
}

describe("DSH host adapter", () => {
  it("forwards only the trusted host session to the DSH session service", async () => {
    const calls: string[] = [];
    const service: DshSessionService = {
      owns: (sessionId) => sessionId === "session-1",
      followup: async ({ sessionId }) => { calls.push("followup:" + sessionId); },
      steer: async ({ sessionId }) => { calls.push("steer:" + sessionId); },
      cancel: async ({ sessionId }) => { calls.push("cancel:" + sessionId); },
    };
    const port = createDshHostAgentPort({ sessions: service });
    await port.followup({ requestId: "req-1", roomId: "room-1", hostSessionId: "session-1", authorMemberId: "member-2", text: "hello" });
    await port.steer({ requestId: "req-2", roomId: "room-1", hostSessionId: "session-1", authorMemberId: "member-2", text: "stop" });
    await port.cancel({ requestId: "req-3", roomId: "room-1", hostSessionId: "session-1", keepInbox: true });
    expect(calls).toEqual(["followup:session-1", "steer:session-1", "cancel:session-1"]);
    await expect(port.followup({ requestId: "req-4", roomId: "room-1", hostSessionId: "other", authorMemberId: "member-2", text: "no" })).rejects.toThrow("not owned");
  });

  it("registers and disposes the HTTP prefix and exact stream upgrade", () => {
    const stub = webServerStub();
    const dispose = registerDshCollabHost({ webServer: stub.webServer, http: { gateway: {} as never }, upgrade: { handleUpgrade: vi.fn() } as never });
    expect(stub.http).toEqual(["/collab"]);
    expect(stub.upgrades).toEqual(["/collab/v1/stream"]);
    dispose();
    expect(stub.http).toEqual([]);
    expect(stub.upgrades).toEqual([]);
  });
});
