import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindCollabPublishUpdateTool } from "../../src/dsh-collab-tools.js";
import { DshWorkspaceControl } from "../../src/dsh-workspace-control.js";
import { RoomProjectStore } from "../../src/room-projects.js";
import { localDshSubprocess } from "../helpers/local-dsh-subprocess.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function roomProjects(workspacePath: string): RoomProjectStore {
  const projects = new RoomProjectStore();
  projects.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas", workspacePath });
  return projects;
}

function workspaceRequest(sessionId: string) {
  return {
    sessionId,
    room: {
      roomId: "room-1",
      memberId: "member-1",
      role: "participant" as const,
      connection: "online" as const,
      members: [{ memberId: "member-1", displayName: "Member" }],
      roomEvents: [],
    },
    remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
    action: {},
  };
}

describe("Room Project operation scope", () => {
  it("rejects a ChangeSet projection from a private Session before contacting the gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-room-project-scope-"));
    roots.push(root);
    const fetch = vi.fn(async () => { throw new Error("gateway must not be contacted"); });
    const privatePath = join(root, "private");
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(),
      fetch,
      agents: { get: () => ({ id: "session-private", session: { header: { cwd: privatePath } } }) },
      roomProjects: roomProjects(join(root, "room")),
    });

    await expect(control.handle("workspace/refresh", workspaceRequest("session-private"))).rejects.toThrow("Room Project");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not register collab_publish_update for an Agent outside its Room Project", () => {
    const root = join(tmpdir(), "dsh-collab-room-project-tool");
    let definition: unknown;
    const agent = {
      id: "session-private",
      session: { header: { cwd: join(root, "private") } },
      ctx: {
        tools: { register: vi.fn((next) => { definition = next; return () => undefined; }) },
        on: vi.fn(() => () => undefined),
      },
    };
    expect(() => bindCollabPublishUpdateTool({
      agents: { get: () => agent },
      projects: roomProjects(join(root, "room")),
      sessionId: "session-private",
      publisher: { publish: async () => { throw new Error("must not publish"); } },
    })).toThrow("Room Project");
    expect(definition).toBeUndefined();
  });
});
