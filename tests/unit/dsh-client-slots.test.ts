import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { apply, applyDshCollabClient, createDshBrowserEasyTierTransport, createDshGatewayControlPort, createDshParticipantPersistence, createDshParticipantSecretPort, createDshParticipantWorkspaceOpener, createDshSettingsPort, decodeDshParticipantSettings, DshCollabSettingsCard, inject, type DshCollabClientContext, type DshCollabClientSnapshot } from "../../src/dsh-client.js";
import { DshCollabSettingsPanel } from "../../src/collab-settings-card.js";
import { closeDshCollabRoom, openDshCollabRoom } from "../../src/collab-rooms.js";
import type { ParticipantResumeState } from "../../src/dsh-browser-client.js";
import type { DshCollabJoinedRoom } from "../../src/settings-shared.js";

const snapshot: DshCollabClientSnapshot = { roomId: "room-1", roomTitle: "Release", hostDisplayName: "Host", role: "host", connection: "online", onlineCount: 3, canSteer: true };

function memoryParticipantSecrets() {
  const records = new Map<string, ParticipantResumeState>();
  let sequence = 0;
  return {
    save: vi.fn(async (state: ParticipantResumeState) => {
      const key = `dsh-collab/participant-test-${String(++sequence)}`;
      records.set(key, structuredClone(state));
      return key;
    }),
    load: vi.fn(async (key: string) => {
      const state = records.get(key);
      if (!state) throw new Error("missing credential");
      return structuredClone(state);
    }),
    remove: vi.fn(async (key: string) => { records.delete(key); }),
  };
}

describe("real DSH client slot adapter", () => {
  it("reuses the registered native Room Workspace when the project already has an id", async () => {
    const order: string[] = [];
    const opener = createDshParticipantWorkspaceOpener({
      workspaces: {
        create: async () => {
          order.push("create-workspace");
          return { workspaceId: "unexpected" };
        },
      },
      workspaceNavigation: {
        connectWorkspace: async (workspaceId) => {
          order.push(`connect-workspace:${workspaceId}`);
          return "session-room";
        },
      },
      sessions: {
        open: () => { order.push("open-session"); },
      },
      panelHost: () => ({
        register: () => () => {},
        open: () => { order.push("open-collab-bar"); },
      }),
    });

    await opener({
      roomId: "room-1",
      path: "C:\\rooms\\room-1\\workspace",
      nativeWorkspaceId: "registered-room-workspace",
      gatewayEndpoint: "ws://10.0.0.1:4310/collab",
      roomTitle: "Release",
      hostDisplayName: "Host",
    });

    expect(order).toEqual([
      "connect-workspace:registered-room-workspace",
      "open-session",
      "open-collab-bar",
    ]);
  });

  it("exports the DSH client runner apply entry", () => {
    expect(apply).toBe(applyDshCollabClient);
    expect(inject).toEqual([
      "slots",
      "settingsScope",
      "connection",
      "locale",
      "workspaces",
      "uiWorkspace",
      "sessions",
    ]);
  });

  it("starts and stops the Host Gateway only through the official Connection RPC", async () => {
    const calls: string[] = [];
    const base = { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() };
    const port = createDshGatewayControlPort(base, {
      call: vi.fn(async (_channel: string, endpoint: string) => {
        calls.push(endpoint);
        if (endpoint === "rooms/list") return { ok: true, value: { rooms: [] } };
        return { ok: true, value: endpoint.endsWith("start") ? { status: "running", port: 4310 } : { status: "stopped" } };
      }),
    });

    expect(port.getGatewaySnapshot?.()).toEqual({ status: "stopped" });
    expect(calls).toEqual([]);
    await port.startGateway?.();
    expect(port.getGatewaySnapshot?.()).toEqual({ status: "running", port: 4310 });
    await port.stopGateway?.();
    expect(port.getGatewaySnapshot?.()).toEqual({ status: "stopped" });
    expect(calls).toEqual(["gateway/start", "rooms/list", "gateway/stop", "rooms/list"]);
  });

  it("inspects an Owned room repository through the loopback DSH control port", async () => {
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
      expect(endpoint).toBe("repository/inspect");
      expect(payload).toEqual({ roomId: "room-owned" });
      return { ok: true, value: { inspection: { kind: "not-git" } } };
    }) };
    const base = { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() };

    await expect(createDshGatewayControlPort(base, rpc).inspectRepository?.("room-owned")).resolves.toEqual({ kind: "not-git" });
    expect(rpc.call).toHaveBeenCalledWith("/dsh-collab", "repository/inspect", { roomId: "room-owned" });
  });

  it("loads one trusted repository diff layer through the loopback DSH control port", async () => {
    const rpc = { call: vi.fn(async () => ({ ok: true, value: { diff: { path: "src/app.ts", layer: "unstaged", patch: "-old\n+new\n" } } })) };
    const base = { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() };

    await expect(createDshGatewayControlPort(base, rpc).inspectRepositoryDiff?.("room-owned", "src/app.ts", "unstaged")).resolves.toEqual({ path: "src/app.ts", layer: "unstaged", patch: "-old\n+new\n" });
    expect(rpc.call).toHaveBeenCalledWith("/dsh-collab", "repository/diff", { roomId: "room-owned", path: "src/app.ts", layer: "unstaged" });
  });

  it("keeps private Sidecar prompts and streamed results on the requester's loopback control port", async () => {
    const sideTask = {
      task: {
        taskId: "task-1", roomId: "room-joined", type: "explain" as const, localPrompt: "Explain the retry", executor: "requester-local" as const,
        context: { roomEventSeq: 4, selectedRoomEventIds: ["event-1"] }, state: { status: "running" as const },
        publication: { status: "private" as const }, requestedBy: "member-bob", createdAt: 10,
      },
      output: "The retry",
      revision: 2,
    };
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string) => ({
      ok: true,
      value: { sideTask: endpoint === "sidecar/get" ? { ...sideTask, output: "The retry is safe", revision: 3 } : sideTask },
    })) };
    const base = { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() };
    const port = createDshGatewayControlPort(base, rpc);
    const input = {
      roomId: "room-joined", requestedBy: "member-bob", localPrompt: "Explain the retry", roomEventSeq: 4,
      contextMessages: [{ eventId: "event-1", author: "Alice", text: "Use a stable key" }],
    };

    await expect(port.startLocalExplain?.(input)).resolves.toEqual(sideTask);
    await expect(port.getLocalSideTask?.("room-joined")).resolves.toMatchObject({ output: "The retry is safe", revision: 3 });
    await expect(port.cancelLocalSideTask?.("room-joined", "task-1")).resolves.toEqual(sideTask);
    expect(rpc.call.mock.calls).toEqual([
      ["/dsh-collab", "sidecar/start", input],
      ["/dsh-collab", "sidecar/get", { roomId: "room-joined" }],
      ["/dsh-collab", "sidecar/cancel", { roomId: "room-joined", taskId: "task-1" }],
    ]);
  });

  it("rejects malformed local SideTask projections at the browser boundary", async () => {
    const rpc = { call: vi.fn(async () => ({ ok: true, value: { sideTask: {
      task: {
        taskId: "task-1", roomId: "room-joined", type: "explain", localPrompt: "Explain", executor: "requester-local",
        context: { roomEventSeq: 4, selectedRoomEventIds: [] }, state: { status: "running" },
        publication: { status: "private" }, requestedBy: "member-bob", createdAt: 10,
      },
      output: "", revision: 1,
    } } })) };
    const base = { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() };

    await expect(createDshGatewayControlPort(base, rpc).getLocalSideTask?.("room-joined")).rejects.toThrow(/invalid local sidetask/i);
  });

  it("passes Participant snapshot credentials only through the loopback Review request", async () => {
    const reviewPoint = {
      reviewPointId: "d".repeat(64), title: "Parser review", workspaceSnapshotId: "a".repeat(64),
      files: [{ path: "src/parser.ts", status: "modified" as const }],
    };
    const sideTask = {
      task: {
        taskId: "task-review", roomId: "room-joined", type: "review" as const, localPrompt: "Review", executor: "requester-local" as const,
        context: { roomEventSeq: 4, selectedRoomEventIds: ["event-1"], reviewPointId: reviewPoint.reviewPointId, workspaceSnapshotId: reviewPoint.workspaceSnapshotId },
        state: { status: "completed" as const }, publication: { status: "private" as const }, requestedBy: "member-bob", createdAt: 10,
      },
      output: "One issue.",
      findings: [{ severity: "high" as const, location: { kind: "line" as const, path: "src/parser.ts", line: 2 }, body: "Retry duplicates the write." }],
      revision: 3,
    };
    const rpc = { call: vi.fn(async () => ({ ok: true, value: { sideTask } })) };
    const base = {
      getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }),
      getRoomSnapshot: () => ({ roomId: "room-joined", roomTitle: "Review", hostDisplayName: "Alice", role: "participant" as const, connection: "online" as const }),
      getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://192.168.1.10:4312/collab", roomToken: "transient-token" }),
      save: vi.fn(),
    };
    const input = {
      roomId: "room-joined", requestedBy: "member-bob", localPrompt: "Review", roomEventSeq: 4,
      contextMessages: [{ eventId: "event-1", author: "Alice", text: "Review the retry" }], reviewPoint,
    };

    await expect(createDshGatewayControlPort(base, rpc).startLocalReview?.(input)).resolves.toEqual(sideTask);
    expect(rpc.call).toHaveBeenCalledWith("/dsh-collab", "sidecar/start-review", {
      ...input,
      remote: { gatewayEndpoint: "ws://192.168.1.10:4312/collab", roomToken: "transient-token" },
    });
    expect(sideTask).not.toHaveProperty("remote");
  });

  it("publishes only selected local Review findings before recording the server linkage locally", async () => {
    const reviewPointId = "d".repeat(64);
    const workspaceSnapshotId = "a".repeat(64);
    const publicationId = "f".repeat(64);
    const sideTask = {
      task: {
        taskId: "task-review", roomId: "room-joined", type: "review" as const, localPrompt: "Review", executor: "requester-local" as const,
        context: { roomEventSeq: 4, selectedRoomEventIds: ["event-1"], reviewPointId, workspaceSnapshotId },
        state: { status: "completed" as const }, publication: { status: "private" as const }, requestedBy: "member-bob", createdAt: 10,
      },
      output: "Two findings.",
      findings: [
        { severity: "high" as const, location: { kind: "line" as const, path: "src/parser.ts", line: 2 }, body: "Retry duplicates the write." },
        { severity: "note" as const, location: { kind: "general" as const }, body: "Naming could be clearer." },
      ],
      revision: 3,
    };
    const published = {
      ...sideTask,
      task: { ...sideTask.task, publication: { status: "published" as const, publicationId, publishedAt: 30 } },
      revision: 4,
    };
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: { sideTask: endpoint === "sidecar/mark-published" ? published : sideTask } })) };
    const publishReviewPublication = vi.fn(async () => ({
      publicationId, roomId: "room-joined", reviewPointId, taskId: "task-review", workspaceSnapshotId,
      publishedBy: "member-bob", summary: "Two findings.", findingIds: ["e".repeat(64)], state: "published" as const, createdAt: 30,
    }));
    const base = {
      getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }),
      getRoomSnapshot: () => ({ roomId: "room-joined", memberId: "member-bob", roomTitle: "Review", hostDisplayName: "Alice", role: "participant" as const, connection: "online" as const }),
      listReviewPublications: vi.fn(async () => ({ publications: [] })),
      publishReviewPublication,
      save: vi.fn(),
    };

    const result = await createDshGatewayControlPort(base, rpc).publishLocalReview?.("room-joined", "task-review", [1, 0]);

    expect(result).toEqual(published);
    expect(publishReviewPublication).toHaveBeenCalledWith("room-joined", reviewPointId, {
      taskId: "task-review", workspaceSnapshotId, summary: "Two findings.", findings: sideTask.findings,
    });
    expect(rpc.call.mock.calls).toEqual([
      ["/dsh-collab", "sidecar/get", { roomId: "room-joined" }],
      ["/dsh-collab", "sidecar/mark-published", { roomId: "room-joined", taskId: "task-review", publicationId, publishedAt: 30 }],
    ]);
  });

  it("repairs a local publication link when the server accepted it before the local write completed", async () => {
    const reviewPointId = "d".repeat(64);
    const workspaceSnapshotId = "a".repeat(64);
    const publicationId = "f".repeat(64);
    const sideTask = {
      task: {
        taskId: "task-review", roomId: "room-joined", type: "review" as const, localPrompt: "Review", executor: "requester-local" as const,
        context: { roomEventSeq: 4, selectedRoomEventIds: [], reviewPointId, workspaceSnapshotId },
        state: { status: "completed" as const }, publication: { status: "private" as const }, requestedBy: "member-bob", createdAt: 10,
      },
      output: "One finding.",
      findings: [{ severity: "high" as const, location: { kind: "general" as const }, body: "Retry duplicates the write." }],
      revision: 3,
    };
    const published = {
      ...sideTask,
      task: { ...sideTask.task, publication: { status: "published" as const, publicationId, publishedAt: 30 } },
      revision: 4,
    };
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: { sideTask: endpoint === "sidecar/mark-published" ? published : sideTask } })) };
    const publishReviewPublication = vi.fn();
    const base = {
      getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }),
      getRoomSnapshot: () => ({ roomId: "room-joined", memberId: "member-bob", roomTitle: "Review", hostDisplayName: "Alice", role: "participant" as const, connection: "online" as const }),
      listReviewPublications: vi.fn(async () => ({ publications: [{
        publicationId, roomId: "room-joined", reviewPointId, taskId: "task-review", workspaceSnapshotId,
        publishedBy: "member-bob", summary: "One finding.", findingIds: ["e".repeat(64)], state: "published" as const, createdAt: 30,
      }] })),
      publishReviewPublication,
      save: vi.fn(),
    };

    await expect(createDshGatewayControlPort(base, rpc).publishLocalReview?.("room-joined", "task-review", [0])).resolves.toEqual(published);
    expect(publishReviewPublication).not.toHaveBeenCalled();
    expect(rpc.call).toHaveBeenLastCalledWith("/dsh-collab", "sidecar/mark-published", {
      roomId: "room-joined", taskId: "task-review", publicationId, publishedAt: 30,
    });
  });

  it("rejects local SideTask projections that do not match the requested room, requester, or task", async () => {
    const sideTask = {
      task: {
        taskId: "task-1", roomId: "room-joined", type: "explain" as const, localPrompt: "Explain", executor: "requester-local" as const,
        context: { roomEventSeq: 4, selectedRoomEventIds: ["event-1"] }, state: { status: "running" as const },
        publication: { status: "private" as const }, requestedBy: "member-bob", createdAt: 10,
      },
      output: "", revision: 1,
    };
    const base = { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() };
    const input = {
      roomId: "room-joined", requestedBy: "member-bob", localPrompt: "Explain", roomEventSeq: 4,
      contextMessages: [{ eventId: "event-1", author: "Alice", text: "Context" }],
    };

    const wrongRoom = createDshGatewayControlPort(base, { call: vi.fn(async () => ({ ok: true, value: { sideTask: { ...sideTask, task: { ...sideTask.task, roomId: "room-other" } } } })) });
    await expect(wrongRoom.getLocalSideTask?.("room-joined")).rejects.toThrow(/invalid local sidetask/i);

    const wrongRequester = createDshGatewayControlPort(base, { call: vi.fn(async () => ({ ok: true, value: { sideTask: { ...sideTask, task: { ...sideTask.task, requestedBy: "member-other" } } } })) });
    await expect(wrongRequester.startLocalExplain?.(input)).rejects.toThrow(/invalid local sidetask/i);

    const wrongTask = createDshGatewayControlPort(base, { call: vi.fn(async () => ({ ok: true, value: { sideTask: { ...sideTask, task: { ...sideTask.task, taskId: "task-other" } } } })) });
    await expect(wrongTask.cancelLocalSideTask?.("room-joined", "task-1")).rejects.toThrow(/invalid local sidetask/i);

    const leakedCredential = createDshGatewayControlPort(base, { call: vi.fn(async () => ({ ok: true, value: { sideTask: { ...sideTask, roomToken: "must-not-project" } } })) });
    await expect(leakedCredential.getLocalSideTask?.("room-joined")).rejects.toThrow(/invalid local sidetask/i);
  });

  it("preserves class-backed room actions when adding Gateway controls", async () => {
    class BrowserSettings {
      readonly shared: string[] = [];

      getSnapshot() {
        return { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" };
      }

      async save(): Promise<void> {}

      async shareHostRoom(input: { roomId: string; hostSessionId: string }): Promise<void> {
        this.shared.push(`${input.roomId}:${input.hostSessionId}`);
      }
    }
    const base = new BrowserSettings();
    const port = createDshGatewayControlPort(base, { call: vi.fn() });

    await port.shareHostRoom?.({ roomId: "room-current", hostSessionId: "session-current", title: "Current" });

    expect(base.shared).toEqual(["room-current:session-current"]);
  });

  it("keeps Settings configuration-only", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port: { getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network" as const, advertisedEndpoint: "ws://192.168.1.20:4310/collab" }), save: vi.fn() } }));
    expect(html).toContain('data-settings-namespace="dsh-collab"');
    expect(html).toContain("Private network exposure");
    expect(html).toContain("Collab Gateway");
    expect(html).not.toContain('name="gatewayHost"');
    expect(html).not.toContain('name="gatewayPort"');
    expect(html).toContain('name="connectionMethod"');
    expect(html).not.toContain("This device only");
    expect(html).not.toContain('name="privateAddress"');
    expect(html).not.toContain('name="derivedEndpoint"');
    expect(html).not.toContain('name="hostInvitationOutput"');
    expect(html).not.toContain("Open Host room");
    expect(html).not.toContain("Create invitation");
    expect(html).not.toContain('name="participantInvitation"');
    expect(html).not.toContain("Join someone else");
    expect(html).not.toContain("data-room-role");
    expect(html).not.toContain("Host your own room");
    expect(html).not.toContain('name="participantGatewayUrl"');
    expect(html).not.toContain('name="inviteToken"');
  });

  it("registers only additive DSH slots and waits for their declarations", () => {
    const registrations: Array<{ name: string; options: Record<string, unknown> }> = [];
    const context = {
      slots: {
        inject: vi.fn((_name: string, register: () => unknown) => register()),
        register: vi.fn((options: Record<string, unknown>) => { registrations.push({ name: String(options.name), options }); return () => {}; }),
      },
      get: vi.fn((name: string) => name === "settingsScope" ? { bind: vi.fn(() => ({
        getSnapshot: () => ({ status: "ready", value: { gateway: { gatewayHost: "127.0.0.1", gatewayPort: 3080, exposeMode: "loopback" } }, writable: true }),
        subscribe: () => () => {}, set: vi.fn(), unset: vi.fn(),
      })) } : undefined),
    };
    applyDshCollabClient(context as DshCollabClientContext);
    expect(registrations).toEqual([
      { name: "sidebar.footer.action", options: expect.objectContaining({ id: "dsh-collab", order: 20, locale: "dsh-collab" }) },
      { name: "shell.overlay", options: expect.objectContaining({ id: "dsh-collab-rooms", order: 10, locale: "dsh-collab" }) },
      { name: "settings.plugin.item", options: expect.objectContaining({ key: "dsh-collab", locale: "dsh-collab" }) },
    ]);
    expect(context.slots.inject).not.toHaveBeenCalledWith("conversation.session.header.actions", expect.any(Function));
    expect(context.slots.inject).toHaveBeenCalledWith("sidebar.footer.action", expect.any(Function));
    expect(context.slots.inject).toHaveBeenCalledWith("shell.overlay", expect.any(Function));
    expect(context.slots.inject).toHaveBeenCalledWith("settings.plugin.item", expect.any(Function));
    expect(context.slots.inject).not.toHaveBeenCalledWith("settings.plugins.tab", expect.any(Function));
  });

  it("provides the Host Room Project creator to the registered Rooms overlay", () => {
    let overlay: ((props: Record<string, unknown>) => unknown) | undefined;
    const betterSidebar = {
      version: "0.17.1",
      features: ["targetedOpen"],
      registerTab: vi.fn(() => () => {}),
      openTab: vi.fn(),
      getSnapshot: () => ({ sessionId: "source-session", cwd: "C:\\work\\atlas" }),
    };
    const context = {
      slots: {
        inject: vi.fn((_name: string, register: () => unknown) => register()),
        register: vi.fn((options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown) => {
          if (options.name === "shell.overlay") overlay = component;
          return () => {};
        }),
      },
      get: vi.fn((name: string) => {
        if (name === "betterSidebar") return betterSidebar;
        if (name === "connection") return { rpc: { call: vi.fn() } };
        if (name === "workspaces") return { create: vi.fn(), pickDirectory: vi.fn() };
        if (name === "uiWorkspace") return { connectWorkspace: vi.fn() };
        if (name === "sessions") return { open: vi.fn() };
        return undefined;
      }),
    };

    applyDshCollabClient(context as unknown as DshCollabClientContext);

    const element = overlay?.({}) as React.ReactElement<{ createOwnedRoom?: unknown }> | undefined;
    expect(element?.props.createOwnedRoom).toEqual(expect.any(Function));
  });

  it("opens a Joined Room through the installed-plugin production composition", async () => {
    const order: string[] = [];
    let connected = false;
    let overlay: ((props: Record<string, unknown>) => unknown) | undefined;
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
      expect(_channel).toBe("/dsh-collab");
      if (endpoint !== "participant/room-project/join") throw new Error("Unexpected RPC: " + endpoint);
      order.push("join-room-project");
      expect(payload).toEqual({
        roomId: "room-joined",
        memberId: "member-alice",
        roomTitle: "Release",
        gatewayEndpoint: "ws://192.168.1.3:4310/collab",
        roomToken: "room-token",
      });
      return { ok: true, value: {
        roomId: "room-joined",
        memberId: "member-alice",
        roomTitle: "Release",
        workspacePath: "C:\\rooms\\room-joined\\workspace",
        nativeWorkspaceId: "workspace-room-joined",
      } };
    }) };
    const collabSettings = {
      getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }),
      save: vi.fn(async () => {}),
      connectJoinedRoom: vi.fn(async () => {
        order.push("connect-joined-room");
        connected = true;
      }),
      getRoomSnapshot: () => ({
        roomId: connected ? "room-joined" : "other-room",
        gatewayEndpoint: "ws://192.168.1.3:4310/collab",
        memberId: connected ? "member-alice" : "other-member",
        roomTitle: "Release",
        hostDisplayName: "Host",
        role: "participant" as const,
        connection: connected ? "online" as const : "offline" as const,
      }),
      getLocalSnapshotAccess: () => ({
        gatewayEndpoint: "ws://192.168.1.3:4310/collab",
        roomToken: "room-token",
      }),
    };
    const createWorkspace = vi.fn(async () => ({ workspaceId: "unexpected-workspace" }));
    const connectWorkspace = vi.fn(async (workspaceId: string) => {
      order.push("connect-workspace:" + workspaceId);
      return "session-room-joined";
    });
    const openSession = vi.fn((sessionId: string) => { order.push("open-session:" + sessionId); });
    const openTab = vi.fn((_seed: unknown, target: { sessionId: string; cwd?: string }) => {
      order.push("open-collab-bar:" + target.sessionId);
    });
    const betterSidebar = {
      version: "0.18.0",
      features: ["targetedOpen"],
      registerTab: vi.fn(() => () => {}),
      openTab,
    };
    const context = {
      slots: {
        inject: vi.fn((_name: string, register: () => unknown) => register()),
        register: vi.fn((options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown) => {
          if (options.name === "shell.overlay") overlay = component;
          return () => {};
        }),
      },
      get: vi.fn((name: string) => {
        if (name === "betterSidebar") return betterSidebar;
        if (name === "collabClient") return { getSnapshot: () => snapshot, subscribe: () => () => {}, send: vi.fn() };
        if (name === "collabSettings") return collabSettings;
        if (name === "connection") return { rpc };
        if (name === "workspaces") return { create: createWorkspace };
        if (name === "uiWorkspace") return { connectWorkspace };
        if (name === "sessions") return { open: openSession };
        return undefined;
      }),
      inject: vi.fn((_services: string[], callback: (scope: unknown) => void) => callback(context)),
    };

    applyDshCollabClient(context as unknown as DshCollabClientContext);

    const element = overlay?.({}) as React.ReactElement<{ openJoinedRoom?: (room: {
      roomId: string;
      gatewayEndpoint: string;
      roomTitle: string;
      hostDisplayName?: string;
    }) => Promise<void> }> | undefined;
    expect(element?.props.openJoinedRoom).toEqual(expect.any(Function));

    await element!.props.openJoinedRoom!({
      roomId: "room-joined",
      gatewayEndpoint: "ws://192.168.1.3:4310/collab",
      roomTitle: "Release",
      hostDisplayName: "Host",
    });

    expect(order).toEqual([
      "connect-joined-room",
      "join-room-project",
      "connect-workspace:workspace-room-joined",
      "open-session:session-room-joined",
      "open-collab-bar:session-room-joined",
    ]);
    expect(collabSettings.connectJoinedRoom).toHaveBeenCalledWith({
      gatewayEndpoint: "ws://192.168.1.3:4310/collab",
      roomId: "room-joined",
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(connectWorkspace).toHaveBeenCalledWith("workspace-room-joined");
    expect(openSession).toHaveBeenCalledWith("session-room-joined");
    expect(openTab).toHaveBeenCalledWith(
      { type: "dsh-collab:room", url: "dsh-collab://panel" },
      { sessionId: "session-room-joined", cwd: "C:\\rooms\\room-joined\\workspace" },
    );
  });

  it("prepares an EasyTier Owner invitation through loopback RPC while preserving the Gateway invite token", async () => {
    const network = {
      mode: "easytier" as const, version: 1 as const, networkName: "room-1", networkSecret: "network-secret",
      ownerVirtualAddress: "10.231.0.1", sharedNode: "tcp://public.kkrainbow.top:11010",
    };
    const createInvite = vi.fn(async (input: object) => ({ invitation: JSON.stringify(input) }));
    const base = {
      getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network" as const, advertisedEndpoint: "ws://10.231.0.1:4310/collab", connectionMethod: "easytier" as const }),
      save: vi.fn(async () => {}),
      createInvite,
    };
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === "gateway/status") return { ok: true, value: { status: "running", port: 4310 } };
      if (endpoint === "rooms/list") return { ok: true, value: { rooms: [] } };
      if (endpoint === "easytier/owner/start") return { ok: true, value: { role: "owner", roomId: "room-1", gatewayEndpoint: "ws://10.231.0.1:4310/collab", localVirtualAddress: "10.231.0.1", network } };
      throw new Error(endpoint);
    }) };
    const port = createDshGatewayControlPort(base, rpc);
    await port.refreshGateway?.();

    await port.createInvite?.({ expiresAt: 100, gatewayEndpoint: "ws://10.231.0.1:4310/collab" }, "room-1");

    expect(rpc.call).toHaveBeenCalledWith("/dsh-collab", "easytier/owner/start", { roomId: "room-1", gatewayPort: 4310 });
    expect(createInvite).toHaveBeenCalledWith(expect.objectContaining({ gatewayEndpoint: "ws://10.231.0.1:4310/collab", network }), "room-1");
  });

  it("restarts a saved EasyTier Owner network when the user explicitly shares the room again", async () => {
    const shareHostRoom = vi.fn(async () => {});
    const base = {
      getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network" as const, advertisedEndpoint: "ws://10.231.0.1:4310/collab", connectionMethod: "easytier" as const }),
      save: vi.fn(async () => {}),
      shareHostRoom,
    };
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === "gateway/status") return { ok: true, value: { status: "running", port: 4310 } };
      if (endpoint === "easytier/owner/start") return { ok: true, value: { role: "owner", roomId: "room-1", gatewayEndpoint: "ws://10.231.0.1:4310/collab", localVirtualAddress: "10.231.0.1", network: { mode: "easytier", version: 1, networkName: "room-1", networkSecret: "network-secret", ownerVirtualAddress: "10.231.0.1", sharedNode: "tcp://public.kkrainbow.top:11010" } } };
      if (endpoint === "rooms/list") return { ok: true, value: { rooms: [] } };
      throw new Error(endpoint);
    }) };
    const port = createDshGatewayControlPort(base, rpc);
    await port.refreshGateway?.();

    await port.shareHostRoom?.({ roomId: "room-1", hostSessionId: "session-native", title: "Release" });

    expect(rpc.call).toHaveBeenCalledWith("/dsh-collab", "easytier/owner/start", { roomId: "room-1", gatewayPort: 4310 });
    expect(shareHostRoom).toHaveBeenCalledWith({ roomId: "room-1", hostSessionId: "session-native", title: "Release" });
  });

  it("stops the active EasyTier Owner transport even after settings switch to LAN", async () => {
    let connectionMethod: "easytier" | "private-network" = "easytier";
    const stopSharing = vi.fn(async () => { connectionMethod = "private-network"; });
    const base = {
      getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network" as const, advertisedEndpoint: "", connectionMethod }),
      save: vi.fn(async () => {}),
      stopSharing,
    };
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === "easytier/status") return { ok: true, value: { active: true, role: "owner", roomId: "room-1", runtime: { kind: "running" } } };
      if (endpoint === "easytier/stop") return { ok: true, value: { kind: "idle" } };
      throw new Error(endpoint);
    }) };
    const port = createDshGatewayControlPort(base, rpc);

    await port.stopSharing?.("room-1");

    expect(stopSharing).toHaveBeenCalledWith("room-1");
    expect(rpc.call).toHaveBeenCalledWith("/dsh-collab", "easytier/stop", {});
  });

  it("maps Participant EasyTier control responses into a browser-local bridge", async () => {
    const rpc = { call: vi.fn(async () => ({ ok: true, value: { role: "participant", roomId: "room-1", gatewayEndpoint: "ws://127.0.0.1:45231/collab", localVirtualAddress: "10.231.2.3" } })) };
    const transport = createDshBrowserEasyTierTransport(rpc);
    const network = {
      mode: "easytier" as const, version: 1 as const, networkName: "room-1", networkSecret: "network-secret",
      ownerVirtualAddress: "10.231.0.1", sharedNode: "tcp://public.kkrainbow.top:11010",
    };

    await expect(transport.startParticipant({ roomId: "room-1", gatewayPort: 4310, network })).resolves.toEqual({
      gatewayEndpoint: "ws://127.0.0.1:45231/collab",
      localVirtualAddress: "10.231.2.3",
    });
    expect(rpc.call).toHaveBeenCalledWith("/dsh-collab", "easytier/participant/start", { roomId: "room-1", gatewayPort: 4310, network });
  });

  it("registers the Collab Bar with Better Sidebar without blocking the client plugin", () => {
    let panelHost: { register(input: { id: string; title: string; render(): null }): () => void; open(input: { sessionId: string }): void } | undefined;
    let descriptor: { id: string; title: string | (() => string); component(input: { scope: { sessionId: string; cwd?: string }; visible: boolean }): unknown } | undefined;
    const registerTab = vi.fn((input) => { descriptor = input; return () => {}; });
    const betterSidebar = {
      version: "0.17.1",
      features: ["targetedOpen"],
      registerTab,
      openTab: vi.fn(),
      getSnapshot: () => ({ sessionId: "session-current" }),
    };
    let workspacePorts: unknown;
    const connection = { rpc: { call: vi.fn() } };
    const context = {
      slots: { inject: vi.fn((_name: string, register: () => unknown) => register()), register: vi.fn(() => () => {}) },
      get: vi.fn((name: string) => name === "betterSidebar" ? betterSidebar : name === "connection" ? connection : undefined),
      provide: vi.fn((name: string, value: unknown) => {
        if (name === "collabPanelHost") panelHost = value as typeof panelHost;
        if (name === "collabWorkspacePorts") workspacePorts = value;
      }),
      inject: vi.fn((_services: string[], callback: (scope: unknown) => void) => callback(context)),
    };

    applyDshCollabClient(context as unknown as DshCollabClientContext);

    expect(inject).not.toContain("betterSidebar");
    expect(context.inject).toHaveBeenCalledWith(["betterSidebar"], expect.any(Function));
    expect(panelHost).toBeDefined();
    expect(workspacePorts).toBeDefined();
    expect(registerTab).toHaveBeenCalledOnce();
    expect(descriptor).toMatchObject({ id: "dsh-collab:room", single: true });
    const html = renderToStaticMarkup(descriptor?.component({ scope: { sessionId: "session-current" }, visible: true }) as React.ReactElement);
    expect(html).toContain('data-collab-bar="true"');
    expect(html).not.toContain("Changes are not connected");
    expect(html).not.toContain('data-collab-surface="room"');
  });

  it("composes one native Room Project Session with the project-centric Collab Bar", () => {
    const slotNames: string[] = [];
    let panelHost: { register(input: { id: string; title: string; render(): null }): () => void; open(input: { sessionId: string; cwd?: string }): void } | undefined;
    let descriptor: { id: string; component(input: { scope: { sessionId: string; cwd?: string }; visible: boolean }): unknown } | undefined;
    const betterSidebar = {
      version: "0.17.1",
      features: ["targetedOpen"],
      registerTab: vi.fn((input) => { descriptor = input; return () => {}; }),
      openTab: vi.fn(),
      getSnapshot: () => ({ sessionId: "session-room", cwd: "C:\\rooms\\release\\workspace" }),
    };
    const collabClient = {
      getSnapshot: () => ({
        roomId: "room-1",
        memberId: "member-owner",
        roomTitle: "Release planning",
        hostDisplayName: "Owner",
        role: "host" as const,
        connection: "online" as const,
        onlineCount: 2,
        canSteer: true,
        members: [
          { memberId: "member-owner", displayName: "Owner" },
          { memberId: "member-alice", displayName: "Alice" },
        ],
        timeline: [{ eventId: "event-1", contextEventId: "event-1", seq: 1, kind: "human" as const, authorMemberId: "member-alice", text: "Ready for project review" }],
      }),
      subscribe: () => () => {},
      send: vi.fn(),
    };
    const changesPort = {
      getSnapshot: () => ({ roomId: "room-1", role: "owner" as const, connection: "online" as const, workspace: { kind: "owner" as const, latestVersionId: "version-7" }, staged: [] }),
      subscribe: () => () => {},
      refresh: vi.fn(), sync: vi.fn(), discardAndSync: vi.fn(), createDraft: vi.fn(), submitDraft: vi.fn(), selectChangeSet: vi.fn(),
    };
    const reviewsPort = {
      getSnapshot: () => ({ roomId: "room-1", role: "owner" as const, currentMemberId: "member-owner", connection: "online" as const, members: [{ memberId: "member-owner", displayName: "Owner" }], reviews: [] }),
      subscribe: () => () => {},
      refresh: vi.fn(), selectReview: vi.fn(), assignReviewer: vi.fn(), createFinding: vi.fn(), decide: vi.fn(),
    };
    const context = {
      slots: {
        inject: vi.fn((_name: string, register: () => unknown) => register()),
        register: vi.fn((options: Record<string, unknown>) => { slotNames.push(String(options.name)); return () => {}; }),
      },
      get: vi.fn((name: string) => {
        if (name === "betterSidebar") return betterSidebar;
        if (name === "collabClient") return collabClient;
        if (name === "collabChanges") return changesPort;
        if (name === "collabReviews") return reviewsPort;
        return undefined;
      }),
      provide: vi.fn((name: string, value: unknown) => { if (name === "collabPanelHost") panelHost = value as typeof panelHost; }),
      inject: vi.fn((_services: string[], callback: (scope: unknown) => void) => callback(context)),
    };

    applyDshCollabClient(context as unknown as DshCollabClientContext);
    try {
      openDshCollabRoom({ kind: "owned", roomId: "room-1", hostSessionId: "session-room", roomTitle: "Release planning" }, panelHost, {
        sessionId: "session-room",
        cwd: "C:\\rooms\\release\\workspace",
      });
      const panel = descriptor?.component({ scope: { sessionId: "session-room", cwd: "C:\\rooms\\release\\workspace" }, visible: true }) as React.ReactElement<{ changesPort?: unknown; reviewsPort?: unknown }>;
      expect(panel.props.changesPort).toBe(changesPort);
      expect(panel.props.reviewsPort).toBe(reviewsPort);

      const html = renderToStaticMarkup(panel);
      expect(html).toContain('data-session-id="session-room"');
      expect(html).toContain('data-room-id="room-1"');
      expect(html).toContain("version-7");
      expect(html).toContain("Owner");
      expect(html).toContain("Alice");
      expect(html).toContain("Ready for project review");
      expect(html).toContain(">Activity<");
      expect(html).toContain(">Changes<");
      expect(html).toContain(">Reviews<");
      expect(html).not.toContain("<textarea");
      expect(html).not.toContain('name="collab-text"');
      expect(html).not.toContain('data-collab-agent-queue="true"');
      expect(slotNames).toEqual(["sidebar.footer.action", "shell.overlay", "settings.plugin.item"]);
      expect(context.slots.inject).not.toHaveBeenCalledWith("conversation.session.header.actions", expect.any(Function));
      expect(betterSidebar.openTab).toHaveBeenCalledWith(
        { type: "dsh-collab:room", url: "dsh-collab://panel" },
        { sessionId: "session-room", cwd: "C:\\rooms\\release\\workspace" },
      );
    } finally {
      closeDshCollabRoom("session-room");
    }
  });

  it("opens the native Room Workspace Session before targeting its Collab Bar", async () => {
    const order: string[] = [];
    const opener = createDshParticipantWorkspaceOpener({
      workspaces: {
        create: async () => { order.push("create-workspace"); return { workspaceId: "workspace-room" }; },
      },
      workspaceNavigation: { connectWorkspace: async () => { order.push("connect-workspace"); return "session-room"; } },
      sessions: { open: () => { order.push("open-session"); } },
      panelHost: () => ({
        register: () => () => {},
        open: () => { order.push("open-collab-bar"); },
      }),
    });

    await opener({
      roomId: "room-1",
      path: "C:\\rooms\\room-1\\workspace",
      gatewayEndpoint: "ws://10.0.0.1:4310/collab",
      roomTitle: "Release",
      hostDisplayName: "Host",
    });

    expect(order).toEqual(["create-workspace", "connect-workspace", "open-session", "open-collab-bar"]);
  });

  it("uses the dedicated Gateway default instead of the DSH origin", () => {
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
    const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    let settings: { getSnapshot(): { gatewayPort: number; advertisedEndpoint?: string } } | undefined;
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://127.0.0.1:3082" } });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class {} });
    try {
      applyDshCollabClient({
        slots: { inject: (_name, register) => register(), register: () => () => {} },
        provide: (name, value) => { if (name === "collabSettings") settings = value as typeof settings; },
      });
      expect(settings?.getSnapshot()).toMatchObject({ gatewayPort: 4310, advertisedEndpoint: "" });
    } finally {
      if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
      else Reflect.deleteProperty(globalThis, "location");
      if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor);
      else Reflect.deleteProperty(globalThis, "WebSocket");
    }
  });

  it("reads and persists namespaced settings through the DSH settings scope", async () => {
    let value = {
      gateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" },
      appliedGateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" },
    };
    const set = vi.fn(async (field: string, next: unknown) => { value = { ...value, [field]: next }; });
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value, writable: true }),
      subscribe: () => () => {}, set, unset: vi.fn(),
    };
    const configureGateway = vi.fn();
    const actions = { getSnapshot: () => value.gateway, save: vi.fn(), configureGateway };
    const port = createDshSettingsPort(scope, actions);

    expect(configureGateway).toHaveBeenCalledWith(value.gateway);
    expect(port.getSnapshot()).toMatchObject({ ...value.gateway, writable: true, tokenTtlMs: 24 * 60 * 60 * 1000, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 5 });
    await port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network", advertisedEndpoint: "wss://new.example/collab" });
    expect(set).toHaveBeenCalledWith("gateway", { gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network", advertisedEndpoint: "" });
    expect(port.getSnapshot()).toMatchObject({ ...value.gateway, tokenTtlMs: 24 * 60 * 60 * 1000, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 5 });
    expect(configureGateway).toHaveBeenLastCalledWith(value.appliedGateway);
    value = { ...value, appliedGateway: value.gateway };
    port.getSnapshot();
    expect(configureGateway).toHaveBeenLastCalledWith(value.gateway);
    await expect(port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "loopback", advertisedEndpoint: "wss://new.example/collab" })).rejects.toThrow("loopback");
    expect(set).toHaveBeenCalledWith("security", { tokenTtlMs: 24 * 60 * 60 * 1000, approvalPolicy: "host-only", maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 5 });
    expect(set).toHaveBeenCalledTimes(2);

    await port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network", advertisedEndpoint: "not a URL" });
    expect(set).toHaveBeenCalledTimes(4);
  });

  it("renders and persists the EasyTier virtual-network connection choice", async () => {
    let persisted = {
      gateway: { gatewayHost: "127.0.0.1" as const, gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" },
    };
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value: persisted, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async (field: string, value: unknown) => { persisted = { ...persisted, [field]: value } as typeof persisted; }),
      unset: vi.fn(async () => {}),
    };
    const actions = {
      getSnapshot: () => ({ ...persisted.gateway }),
      configureGateway: vi.fn(),
      save: vi.fn(async () => {}),
    };
    const port = createDshSettingsPort(scope, actions);
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port }));
    expect(html).toContain('<option value="easytier">');

    await port.save({
      connectionMethod: "easytier",
      easyTierSharedNode: "tcp://public.kkrainbow.top:11010",
      gatewayHost: "0.0.0.0",
      gatewayPort: 4310,
      exposeMode: "network",
      advertisedEndpoint: "",
    });
    expect(persisted).toMatchObject({
      connectionMethod: "easytier",
      easyTierSharedNode: "tcp://public.kkrainbow.top:11010",
      gateway: { gatewayHost: "0.0.0.0", exposeMode: "network" },
    });
  });

  it("reads the configured queue depth without hidden migration", () => {
    const value = {
      gateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" },
      security: { tokenTtlMs: 24 * 60 * 60 * 1000, approvalPolicy: "host-only" as const, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 32 },
    };
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    };

    expect(createDshSettingsPort(scope, { getSnapshot: () => value.gateway, save: vi.fn() }).getSnapshot()).toMatchObject({ maxQueue: 32 });
  });

  it("rejects a save when the DSH settings scope does not commit it", async () => {
    const value = { gateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" } };
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async () => {}),
      unset: vi.fn(),
    };
    const port = createDshSettingsPort(scope, { getSnapshot: () => value.gateway, save: vi.fn() });

    await expect(port.save({
      gatewayHost: "127.0.0.1",
      gatewayPort: 4310,
      exposeMode: "loopback",
      advertisedEndpoint: "wss://host.example/collab",
    })).rejects.toThrow(/not persisted/i);
  });

  it("stores multiple Joined rooms and forgets only the selected membership", async () => {
    let joinedRooms: DshCollabJoinedRoom[] = [];
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value: { joinedRooms }, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async (_field: string, value: unknown) => { joinedRooms = value as typeof joinedRooms; }),
      unset: vi.fn(async () => {}),
    };
    const persistence = createDshParticipantPersistence(scope, memoryParticipantSecrets());
    const first = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret", roomTitle: "Design review" };
    const second = { gatewayEndpoint: "wss://other.example/collab", roomId: "room-3", memberId: "member-bob", credential: "other-secret", roomTitle: "Release" };
    await persistence.save(first);
    await persistence.save(second);
    expect(persistence.list?.()).toEqual([first, second]);
    await persistence.remove?.({ gatewayEndpoint: first.gatewayEndpoint, roomId: first.roomId });
    expect(persistence.list?.()).toEqual([second]);
    expect(scope.set).toHaveBeenLastCalledWith("joinedRooms", [expect.objectContaining({
      gatewayEndpoint: second.gatewayEndpoint,
      roomId: second.roomId,
      memberId: second.memberId,
      credentialKey: expect.stringMatching(/^dsh-collab\/participant-/),
    })]);

    const html = renderToStaticMarkup(createElement(DshCollabSettingsCard, { port: { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() } }));
    expect(html).not.toContain("resume-secret");
    expect(html).not.toContain('name="participant"');
  });

  it("moves Participant secrets only through the dedicated loopback credential RPC", async () => {
    const state = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === "credentials/participant/save") return { ok: true, value: { credentialKey: "dsh-collab/participant-fixed" } };
      if (endpoint === "credentials/participant/load") return { ok: true, value: { state } };
      return { ok: true, value: { deleted: true } };
    }) };
    const secrets = createDshParticipantSecretPort(rpc);

    await expect(secrets.save(state)).resolves.toBe("dsh-collab/participant-fixed");
    await expect(secrets.load("dsh-collab/participant-fixed")).resolves.toEqual(state);
    await secrets.remove("dsh-collab/participant-fixed");

    expect(rpc.call.mock.calls).toEqual([
      ["/dsh-collab", "credentials/participant/save", { state }],
      ["/dsh-collab", "credentials/participant/load", { credentialKey: "dsh-collab/participant-fixed" }],
      ["/dsh-collab", "credentials/participant/delete", { credentialKey: "dsh-collab/participant-fixed" }],
    ]);
  });

  it("rolls back a new Participant grant when settings do not commit its reference", async () => {
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value: { joinedRooms: [] }, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    };
    const secrets = memoryParticipantSecrets();
    const persistence = createDshParticipantPersistence(scope, secrets);
    const state = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };

    await expect(persistence.save(state)).rejects.toThrow(/not persisted/i);

    expect(secrets.remove).toHaveBeenCalledWith(expect.stringMatching(/^dsh-collab\/participant-/));
    expect(persistence.list?.()).toEqual([]);
  });

  it("replaces a Joined room endpoint when the Host address changes", async () => {
    let joinedRooms: DshCollabJoinedRoom[] = [];
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value: { joinedRooms }, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async (_field: string, value: unknown) => { joinedRooms = value as typeof joinedRooms; }),
      unset: vi.fn(async () => {}),
    };
    const persistence = createDshParticipantPersistence(scope, memoryParticipantSecrets());
    const oldEndpoint = { gatewayEndpoint: "wss://10.131.241.65:4310/collab", roomId: "room-2", memberId: "member-bob", credential: "old-secret", roomTitle: "test room" };
    const newEndpoint = { gatewayEndpoint: "ws://192.168.1.3:4310/collab", roomId: "room-2", memberId: "member-bob", credential: "new-secret", roomTitle: "test room" };

    await persistence.save(oldEndpoint);
    await persistence.save(newEndpoint);

    expect(persistence.list?.()).toEqual([newEndpoint]);
  });

  it("decodes only credential-backed Joined room metadata", () => {
    const inline = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };
    const current = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credentialKey: "dsh-collab/participant-fixed" };
    expect(decodeDshParticipantSettings({ resume: inline })).toEqual({});
    expect(decodeDshParticipantSettings({ joinedRooms: [inline] })).toEqual({});
    expect(decodeDshParticipantSettings({ joinedRooms: [current] })).toEqual({ joinedRooms: [current] });
  });

  it("does not connect a saved Joined room when local DSH settings become ready", async () => {
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    const requests: string[] = [];
    let client: { getSnapshot(): DshCollabClientSnapshot } | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string) => {
      requests.push(url);
      const data = url.endsWith("/resume")
        ? { room: { roomId: "room-2", title: "Remote" }, member: { memberId: "member-bob", role: "participant" }, roomToken: "fresh-token" }
        : url.endsWith("/snapshot")
          ? { room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 }
          : { events: [], nextSeq: 0 };
      return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
    } });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class {
      readyState = 1;
      onopen?: () => void;
      onclose?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close(): void { this.readyState = 3; }
      send(): void {}
    } });
    try {
      const binder = { bind: vi.fn((spec: { namespace: string }) => spec.namespace === "dsh-collab-participant" ? {
        getSnapshot: () => ({ status: "ready", value: { resume: { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" } }, writable: true }),
        subscribe: () => () => {}, set: vi.fn(), unset: vi.fn(),
      } : {
        getSnapshot: () => ({ status: "ready", value: { gateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback", advertisedEndpoint: "" } }, writable: true }),
        subscribe: () => () => {}, set: vi.fn(), unset: vi.fn(),
      }) };
      applyDshCollabClient({
        slots: { inject: (_name, register) => register(), register: () => () => {} },
        get: (name) => name === "settingsScope" ? binder : undefined,
        provide: (name, value) => { if (name === "collabClient") client = value as typeof client; },
      } as DshCollabClientContext);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(client?.getSnapshot()).toMatchObject({ connection: "offline" });
      expect(requests.filter((url) => url.endsWith("/resume"))).toHaveLength(0);
    } finally {
      if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor); else Reflect.deleteProperty(globalThis, "fetch");
      if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor); else Reflect.deleteProperty(globalThis, "WebSocket");
    }
  });
});
