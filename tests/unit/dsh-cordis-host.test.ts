import { createConnection, createServer as createTcpServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mountDshCollabCordisHost } from "../../src/dsh-cordis-host.js";
import { authenticateCollabRequest, isLoopbackAddress } from "../../src/http.js";
import { apply, DSH_COLLAB_PARTICIPANT_NAMESPACE, DSH_COLLAB_SETTINGS_NAMESPACE, HostSnapshotFile, type DshCollabPersistedSettings } from "../../src/index.js";
import { RoomStore } from "../../src/room.js";
import { localDshSubprocess } from "../helpers/local-dsh-subprocess.js";

async function freeTcpPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

async function waitUntilListening(port: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Gateway did not listen on ${String(port)}`);
}

describe("Cordis Host mount", () => {
  const noPersistence = { stateFile: false as const };
  it("accepts only loopback Host or an identity asserted by an explicitly trusted proxy", () => {
    const options = {
      hostPrincipalId: "host",
      allowLoopbackPrincipal: true,
      trustedProxyAddresses: ["10.0.0.5"],
      trustedPrincipalHeader: "x-authenticated-user",
      trustedProxyMarkerHeader: "x-forwarded-for",
    };
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { "x-dsh-principal-id": "host" }, remoteAddress: "203.0.113.4" }, options)).toEqual({});
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: {}, remoteAddress: "::1" }, options)).toEqual({ principalId: "host" });
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { origin: "https://evil.example" }, remoteAddress: "::1" }, options)).toEqual({});
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { origin: "http://127.0.0.1:3080" }, remoteAddress: "::1" }, options)).toEqual({ principalId: "host" });
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { "x-forwarded-for": "203.0.113.9" }, remoteAddress: "10.0.0.5" }, options)).toEqual({});
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { "x-forwarded-for": "203.0.113.9", "x-authenticated-user": "alice" }, remoteAddress: "10.0.0.5" }, options)).toEqual({ principalId: "alice" });
  });

  it("registers the formal dsh-collab settings namespace with safe composition defaults", () => {
    const register = vi.fn((_namespace: string, _schema: unknown, options: { base: DshCollabPersistedSettings; validate(value: unknown): void }) => ({ get: () => options.base, update: vi.fn(async () => {}) }));
    const context = {
      agents: { get: () => undefined },
      inject: vi.fn((_services: string[], callback: (ctx: { settings: { register: typeof register } }) => void) => callback({ settings: { register } })),
    };
    apply(context, {
      roomId: "room-1", hostId: "host", title: "Room", hostDisplayName: "Host",
      host: "127.0.0.1", port: 3080,
    });

    expect(context.inject).toHaveBeenCalledWith(["settings"], expect.any(Function));
    expect(register).toHaveBeenCalledWith(
      DSH_COLLAB_SETTINGS_NAMESPACE,
      expect.objectContaining({ toJSON: expect.any(Function) }),
      expect.objectContaining({
        base: expect.objectContaining({
          gateway: { gatewayHost: "127.0.0.1", gatewayPort: 3080, exposeMode: "loopback", advertisedEndpoint: "" },
          security: { tokenTtlMs: 24 * 60 * 60 * 1000, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 5, approvalPolicy: "host-only" },
        }),
        validate: expect.any(Function),
      }),
    );
    expect(register).toHaveBeenCalledWith(
      DSH_COLLAB_PARTICIPANT_NAMESPACE,
      expect.objectContaining({ toJSON: expect.any(Function) }),
      expect.objectContaining({ validate: expect.any(Function) }),
    );
    const options = register.mock.calls[0]?.[2];
    if (!options) throw new Error("settings registration options were not captured");
    expect(() => options.validate({ gateway: { gatewayHost: "0.0.0.0", gatewayPort: 3080, exposeMode: "loopback" } })).toThrow("loopback");
  });

  it("applies persisted security settings to the Host runtime after restart", async () => {
    const gatewayPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    const persisted = {
      gateway: { gatewayHost: "127.0.0.1" as const, gatewayPort, exposeMode: "loopback" as const, advertisedEndpoint: "" },
      security: { tokenTtlMs: 25, approvalPolicy: "disabled" as const, maxMembers: 2, maxMessageBytes: 4, maxQueue: 1 },
    };
    let resolved: DshCollabPersistedSettings = persisted;
    let control: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
    const update = vi.fn(async (patch: object) => { resolved = { ...resolved, ...patch as Partial<DshCollabPersistedSettings> }; });
    const context = {
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } } }) => void) => callback({ settings: { register: () => ({ get: () => resolved, update }) } }),
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
      connection: { rpc: { handle: vi.fn((_channel: string, handler: typeof control) => { control = handler; return async () => {}; }) } },
    };

    apply(context, {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
      allowLoopbackPrincipal: true, tokenTtlMs: 1000, maxMessageBytes: 1000, now: () => 10, tokenFactory: () => "room-token",
      ...noPersistence,
    });
    await control!("gateway/start", {}, new AbortController().signal);
    await waitUntilListening(gatewayPort);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ gateway: persisted.gateway, appliedGateway: persisted.gateway }));

    try {
      const bootstrap = await fetch(`http://127.0.0.1:${String(gatewayPort)}/collab/v1/rooms/room-1/bootstrap`);
      const bootstrapBody = await bootstrap.json() as { data: { expiresAt: number; roomToken: string } };
      expect(bootstrapBody.data.expiresAt).toBe(35);
      const oversized = await fetch(`http://127.0.0.1:${String(gatewayPort)}/collab/v1/rooms/room-1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${bootstrapBody.data.roomToken}`, "content-type": "application/json" },
        body: JSON.stringify({ clientMessageId: "message-1", text: "hello" }),
      });
      expect(oversized.status).toBe(422);
    } finally {
      await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
    }
    expect(await canConnect(gatewayPort)).toBe(false);
  });

  it("starts a dedicated Gateway without mounting routes into the DSH WebServer", async () => {
    const mounted = mountDshCollabCordisHost({
      agents: { get: (sessionId) => sessionId === "session-1" ? { followup: () => {}, steer: () => {}, cancel: () => {} } : undefined },
    }, {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: 0, ...noPersistence,
    });
    expect(mounted).toBeDefined();
    const port = await mounted!.ready;
    expect(port).toBeGreaterThan(0);
    expect(await canConnect(port)).toBe(true);
    await mounted!.dispose();
    expect(await canConnect(port)).toBe(false);
  });

  it("composes the dormant ChangeSet Staging service only when real workspace dependencies are available", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-staging-composition-"));
    try {
      const mounted = mountDshCollabCordisHost({
        agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
        fs: {
          resolve: async (path, options) => ({ targetKey: [options?.cwd, path], displayPath: path }),
          contains: () => true,
          lstat: async () => ({ type: "file" as const }),
          readBytes: async () => new Uint8Array(),
        },
        subprocess: localDshSubprocess(),
      }, {
        roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
        port: 0, stateFile: false, changeSetRoot: root,
      });
      expect(mounted?.runtime.changeSets).toBeDefined();
      await mounted?.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("composes apply and crash recovery only with durable journal storage and the real DSH write seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-apply-composition-"));
    try {
      const mounted = mountDshCollabCordisHost({
        agents: { get: () => ({
          followup: () => {}, steer: () => {}, cancel: () => {},
          session: { events: [], header: { cwd: root } },
        }) },
        fs: {
          resolve: async (path, options) => ({ targetKey: join(options?.cwd ?? root, path), displayPath: path }),
          contains: () => true,
          processPath: (target) => String(target.targetKey),
          lstat: async () => undefined,
          readBytes: async () => new Uint8Array(),
          writeText: async () => ({}),
        },
        subprocess: localDshSubprocess(),
      }, {
        roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
        port: 0,
        stateFile: join(root, "state.json"),
        changeSetRoot: join(root, "change-sets"),
        integrationJournalRoot: join(root, "journals"),
      });
      expect(mounted?.runtime.changeSetIntegration).toBeDefined();
      expect(mounted?.runtime.snapshot().changeSetApply).toEqual({ version: 1, conflicts: [] });
      await mounted?.ready;
      await mounted?.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to listen when a pending integration journal cannot be recovered", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-unavailable-recovery-"));
    const journalRoot = join(root, "journals");
    await mkdir(join(journalRoot, "a".repeat(64)), { recursive: true });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mounted = mountDshCollabCordisHost({
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
    }, {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
      port: 0,
      stateFile: join(root, "state.json"),
      integrationJournalRoot: journalRoot,
    });
    try {
      await expect(mounted?.ready).rejects.toThrow(/recover/i);
      expect(warning).toHaveBeenCalledWith("dsh-collab Gateway failed to listen", expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
    } finally {
      await mounted?.dispose();
      warning.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for an in-flight Gateway listen before immediate disposal", async () => {
    const mounted = mountDshCollabCordisHost({
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
    }, {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: 0, ...noPersistence,
    });
    if (!mounted) throw new Error("Gateway was not mounted");
    const ready = mounted.ready;
    await mounted.dispose();
    const port = await ready;
    expect(await canConnect(port)).toBe(false);
  });

  it("closes the Gateway even when the final persistence write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-dispose-"));
    const blocker = join(dir, "blocked");
    await writeFile(blocker, "not a directory", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mounted = mountDshCollabCordisHost({
        agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
      }, {
        roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: 0,
        stateFile: join(blocker, "state.json"),
      });
      if (!mounted) throw new Error("Gateway was not mounted");
      const port = await mounted.ready;
      await expect(mounted.dispose()).rejects.toBeDefined();
      expect(await canConnect(port)).toBe(false);
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores Host room members and timeline from its state file after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-restart-"));
    const stateFile = join(dir, "state.json");
    const config = { roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: 0, stateFile };
    const context = { agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) } };
    try {
      const first = mountDshCollabCordisHost(context, config);
      if (!first) throw new Error("first Gateway did not mount");
      await first.ready;
      first.runtime.rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 2 });
      first.runtime.ledger.append({ eventId: "event-1", roomId: "room-1", type: "human.message", actor: { memberId: "member-bob", principalId: "bob" }, createdAt: 3, payload: { text: "hello" } });
      await first.dispose();

      const second = mountDshCollabCordisHost(context, config);
      if (!second) throw new Error("second Gateway did not mount");
      await second.ready;
      expect(second.runtime.rooms.listMembers("room-1")).toContainEqual(expect.objectContaining({ memberId: "member-bob" }));
      expect(second.runtime.ledger.readAfter("room-1", 0)).toContainEqual(expect.objectContaining({ eventId: "event-1" }));
      await second.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists Review Point metadata through the Host state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-review-points-"));
    const stateFile = join(dir, "state.json");
    const config = { roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: 0, stateFile };
    const context = { agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) } };
    const files = [{ path: "src/app.ts", contentHash: createHash("sha256").update("app").digest("hex"), size: 3, source: "tracked" as const }];
    const snapshot = {
      snapshotId: "snapshot-1", roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0, headOid: "a".repeat(40),
      manifestHash: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files, createdAt: 10,
    };
    try {
      const first = mountDshCollabCordisHost(context, config);
      if (!first) throw new Error("first Gateway did not mount");
      await first.ready;
      first.runtime.reviewPoints.create({
        roomId: "room-1", principalId: "host", clientRequestId: "review-1", title: "App review", snapshot,
        files: [{ path: "src/app.ts", status: "modified", additions: 1, deletions: 0 }],
        diffs: [{ path: "src/app.ts", kind: "text", oldText: "old\n", newText: "new\n" }],
      });
      await first.dispose();

      const second = mountDshCollabCordisHost(context, config);
      if (!second) throw new Error("second Gateway did not mount");
      await second.ready;
      expect(second.runtime.snapshot().reviewPoints?.reviewPoints).toContainEqual(expect.objectContaining({ title: "App review", workspaceSnapshotId: "snapshot-1" }));
      await second.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can be disabled without starting a Gateway", () => {
    const mounted = mountDshCollabCordisHost({ agents: { get: () => undefined } }, {
      enabled: false, roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
    });
    expect(mounted).toBeUndefined();
  });

  it("keeps the Gateway stopped until the loopback control RPC starts it", async () => {
    const gatewayPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    let control: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
    let persisted: DshCollabPersistedSettings = {
      gateway: { gatewayHost: "127.0.0.1", gatewayPort, exposeMode: "loopback", advertisedEndpoint: "" },
    };
    const context = {
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } } }) => void) => callback({ settings: { register: () => ({ get: () => persisted, update: async (patch: object) => { persisted = { ...persisted, ...patch as Partial<DshCollabPersistedSettings> }; } }) } }),
      connection: { rpc: { handle: vi.fn((_channel: string, handler: NonNullable<typeof control>, options: unknown) => { control = handler; expect(options).toEqual({ authority: "loopback" }); return async () => {}; }) } },
    };
    apply(context, { roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: gatewayPort, ...noPersistence });
    expect(await canConnect(gatewayPort)).toBe(false);
    expect(control).toBeDefined();
    expect(await control!("gateway/status", {}, new AbortController().signal)).toMatchObject({ ok: true, value: { status: "stopped" } });
    await control!("gateway/start", {}, new AbortController().signal);
    await waitUntilListening(gatewayPort);
    expect(await control!("gateway/status", {}, new AbortController().signal)).toMatchObject({ ok: true, value: { status: "running", port: gatewayPort } });
    await control!("gateway/stop", {}, new AbortController().signal);
    expect(await canConnect(gatewayPort)).toBe(false);
    await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
  });

  it("runs private Sidecar Explain tasks through the requester's loopback DSH without starting the Gateway", async () => {
    const gatewayPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    const sessionListeners = new Set<(session: { id: string }, event: { seq: number; type: string; data: unknown }) => void>();
    let control: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
    let sidecarSessionId = "";
    let prompt = "";
    const disposed = vi.fn(async () => {});
    const emit = (event: { seq: number; type: string; data: unknown }): void => {
      for (const listener of sessionListeners) listener({ id: sidecarSessionId }, event);
    };
    let persisted: DshCollabPersistedSettings = {
      gateway: { gatewayHost: "127.0.0.1", gatewayPort, exposeMode: "loopback", advertisedEndpoint: "" },
    };
    const context = {
      agents: {
        get: vi.fn(() => undefined),
        create: vi.fn(async (input: { sessionId: string; setup?: (agentContext: object) => Promise<void> | void }) => {
          sidecarSessionId = input.sessionId;
          await input.setup?.({ on: () => () => {} });
          return {
            agent: {
              followup(message: { id: string; content: [{ text: string }] }) {
                prompt = message.content[0].text;
                emit({ seq: 1, type: "user/message", data: message });
              },
              cancel: vi.fn(),
              whenIdle: vi.fn(async () => {}),
            },
            dispose: disposed,
          };
        }),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: "local-provider", model: "local-model" }) },
      agentPresets: { mount: vi.fn(async () => {}) },
      on: (_event: "session/event", listener: (session: { id: string }, event: { seq: number; type: string; data: unknown }) => void) => {
        sessionListeners.add(listener);
        return () => { sessionListeners.delete(listener); };
      },
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } } }) => void) => callback({ settings: { register: () => ({ get: () => persisted, update: async (patch: object) => { persisted = { ...persisted, ...patch as Partial<DshCollabPersistedSettings> }; } }) } }),
      connection: { rpc: { handle: vi.fn((_channel: string, handler: NonNullable<typeof control>) => { control = handler; return async () => {}; }) } },
    };
    apply(context as unknown as Parameters<typeof apply>[0], { hostId: "host", hostDisplayName: "Host", port: gatewayPort, ...noPersistence });

    expect(await canConnect(gatewayPort)).toBe(false);
    const started = await control!("sidecar/start", {
      roomId: "room-remote",
      requestedBy: "member-bob",
      localPrompt: "Explain the retry.",
      roomEventSeq: 4,
      contextMessages: [{ eventId: "event-1", author: "Alice", text: "Retry uses a stable key." }],
    }, new AbortController().signal);
    expect(started).toMatchObject({ ok: true, value: { sideTask: { task: { roomId: "room-remote", state: { status: "running" } } } } });
    expect(prompt).toContain("Explain the retry.");
    expect(context.agents.get).not.toHaveBeenCalled();
    expect(await canConnect(gatewayPort)).toBe(false);

    emit({ seq: 2, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "The stable key" } } });
    emit({ seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await vi.waitFor(() => { expect(disposed).toHaveBeenCalledOnce(); });
    await expect(control!("sidecar/get", { roomId: "room-remote" }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { sideTask: { output: "The stable key", task: { state: { status: "completed" }, publication: { status: "private" } } } },
    });
    await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
  });

  it("lists persisted Owned rooms as inactive while the Gateway is stopped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-owned-rooms-"));
    const stateFile = join(dir, "state.json");
    const rooms = new RoomStore();
    rooms.createRoom({ roomId: "room-owned", hostId: "host", hostSessionId: "session-owned", title: "Release planning", hostDisplayName: "Host", now: 1 });
    await new HostSnapshotFile(stateFile).save({
      version: 1,
      rooms: rooms.snapshot(),
      ledger: { version: 1, rooms: [] },
      dispatcher: { version: 1, records: [], queue: [], nextQueueSeq: 1 },
    });
    let control: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
    const context = {
      agents: { get: () => undefined },
      effect: () => () => {},
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } } }) => void) => callback({ settings: { register: () => ({
        get: () => ({ gateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback", advertisedEndpoint: "" } }),
        update: async () => {},
      }) } }),
      connection: { rpc: { handle: vi.fn((_channel: string, handler: NonNullable<typeof control>) => { control = handler; return async () => {}; }) } },
    };

    try {
      apply(context, { hostId: "host", hostDisplayName: "Host", stateFile });
      expect(await control!("rooms/list", {}, new AbortController().signal)).toEqual({
        ok: true,
        value: { rooms: [{ roomId: "room-owned", hostSessionId: "session-owned", title: "Release planning", sharing: false }] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("inspects only the active Owned room workspace through the loopback control channel", async () => {
    const disposeEffects: Array<() => void | Promise<void>> = [];
    let control: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": "C:/trusted/workspace\n",
      "--no-optional-locks status --short -z --untracked-files=all": " M src/app.ts\0",
      "diff --no-ext-diff --no-textconv --numstat -z --cached": "",
      "diff --no-ext-diff --no-textconv --numstat -z": "3\t1\tsrc/app.ts\0",
      "diff --no-ext-diff --no-textconv --no-color --unified=0 -- src/app.ts": "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
    };
    const spawn = vi.fn((spec: { argv: readonly string[]; cwd: string }) => {
      const output = outputs[spec.argv.slice(1).join(" ")];
      if (output === undefined) throw new Error(`unexpected git command: ${spec.argv.slice(1).join(" ")}`);
      return {
        collected: {
          stdout: { readFrom: () => ({ text: output, lossy: false }) },
          stderr: { readFrom: () => ({ text: "", lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
      };
    });
    let persisted: DshCollabPersistedSettings = {
      gateway: { gatewayHost: "127.0.0.1", gatewayPort: 0, exposeMode: "loopback", advertisedEndpoint: "" },
    };
    const context = {
      agents: { get: (sessionId: string) => sessionId === "session-owned" ? {
        followup: () => {}, steer: () => {}, cancel: () => {}, session: { events: [], header: { cwd: "C:/trusted/workspace" } },
      } : undefined },
      subprocess: { resolveExecutable: vi.fn(async () => "git.exe"), spawn },
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } } }) => void) => callback({ settings: { register: () => ({
        get: () => persisted,
        update: async (patch: object) => { persisted = { ...persisted, ...patch as Partial<DshCollabPersistedSettings> }; },
      }) } }),
      connection: { rpc: { handle: vi.fn((_channel: string, handler: NonNullable<typeof control>) => { control = handler; return async () => {}; }) } },
    };
    apply(context, { roomId: "room-owned", hostId: "host", hostSessionId: "session-owned", title: "Release", hostDisplayName: "Host", stateFile: false });

    await control!("gateway/start", {}, new AbortController().signal);
    await expect(control!("repository/inspect", { roomId: "room-owned", cwd: "C:/attacker" }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { inspection: {
        kind: "repository",
        root: "C:/trusted/workspace",
        files: [{ path: "src/app.ts", unstaged: { kind: "modified", additions: 3, deletions: 1, binary: false } }],
        summary: { stagedFiles: 0, unstagedFiles: 1, additions: 3, deletions: 1, binaryFiles: 0 },
      } },
    });
    expect(spawn.mock.calls.every(([spec]) => spec.cwd === "C:/trusted/workspace")).toBe(true);
    await expect(control!("repository/diff", { roomId: "room-owned", path: "src/app.ts", layer: "unstaged", cwd: "C:/attacker" }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { diff: { path: "src/app.ts", layer: "unstaged", patch: expect.stringContaining("+new") } },
    });
    await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
  });

  it("does not start the removed local proxy when stale config is present", async () => {
    const targetPort = await freeTcpPort();
    const listenPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    const context = {
      agents: { get: () => undefined },
      effect: (factory: () => (() => void | Promise<void>) | void) => {
        const dispose = factory();
        if (dispose) disposeEffects.push(dispose);
        return () => {};
      },
    };

    try {
      apply(context, { localProxy: { enabled: true, targetPort, listenPort } } as Parameters<typeof apply>[1]);
      expect(disposeEffects).toHaveLength(0);
      expect(await canConnect(listenPort)).toBe(false);
    } finally {
      await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
    }
  }, 10_000);

  it("starts the Gateway without binding a room to the first DSH Agent", async () => {
    const gatewayPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    let control: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
    let persisted: DshCollabPersistedSettings = {
      gateway: { gatewayHost: "127.0.0.1", gatewayPort, exposeMode: "loopback", advertisedEndpoint: "" },
    };
    const context = {
      agents: { get: () => undefined },
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } } }) => void) => callback({ settings: { register: () => ({ get: () => persisted, update: async (patch: object) => { persisted = { ...persisted, ...patch as Partial<DshCollabPersistedSettings> }; } }) } }),
      connection: { rpc: { handle: vi.fn((_channel: string, handler: NonNullable<typeof control>) => { control = handler; return async () => {}; }) } },
    };
    apply(context, { roomId: "room-1", hostId: "host", title: "Room", hostDisplayName: "Host", port: gatewayPort, ...noPersistence });
    expect(await canConnect(gatewayPort)).toBe(false);
    await control!("gateway/start", {}, new AbortController().signal);
    await waitUntilListening(gatewayPort);
    expect((await fetch(`http://127.0.0.1:${String(gatewayPort)}/collab/v1/rooms/room-1/bootstrap`)).status).toBe(404);
    await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
    expect(await canConnect(gatewayPort)).toBe(false);
  });

  it("persists a session room created after the Gateway starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-session-room-"));
    const stateFile = join(dir, "state.json");
    const config = { hostId: "host", hostDisplayName: "Host", port: 0, stateFile, allowLoopbackPrincipal: true };
    const context = { agents: { get: (sessionId: string) => sessionId === "session-current" ? { followup: () => {}, steer: () => {}, cancel: () => {} } : undefined } };
    try {
      const first = mountDshCollabCordisHost(context, config);
      if (!first) throw new Error("first Gateway did not mount");
      await first.ready;
      const shared = await first.runtime.gateway.handle({
        method: "POST", path: "/v1/rooms/session-current/host", auth: { principalId: "host" },
        body: { hostSessionId: "session-current", title: "Release room" },
      });
      expect(shared.status).toBe(200);
      await first.dispose();

      const second = mountDshCollabCordisHost(context, config);
      if (!second) throw new Error("second Gateway did not mount");
      await second.ready;
      expect(second.runtime.rooms.getRoom("session-current")).toMatchObject({ title: "Release room", hostSessionId: "session-current" });
      await second.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
