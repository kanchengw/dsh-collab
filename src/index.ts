export * from "./approvals.js";
export * from "./active-rooms.js";
export * from "./audit.js";
export * from "./room-client.js";
export * from "./room-context.js";
export * from "./room-context-delivery.js";
export * from "./room-session-links.js";
export * from "./room-workspace.js";
export * from "./dsh-room-workspace.js";
export * from "./room-workspace-sync.js";
export * from "./change-sets.js";
export * from "./change-set-staging.js";
export * from "./change-set-reviews.js";
export * from "./change-set-apply.js";
export * from "./change-set-integration.js";
export * from "./canonical-workspace.js";
export * from "./integration-journal.js";
export * from "./dsh-collab-tools.js";
export * from "./gateway.js";
export * from "./dsh-host.js";
export * from "./dsh-local-agent.js";
export * from "./dsh-native-agent-context.js";
export * from "./local-sidecar.js";
export * from "./local-sidecar-store.js";
export * from "./local-sidecar-workspace.js";
export * from "./collaboration-types.js";
export * from "./collaboration-client.js";
export * from "./dsh-cordis-agent.js";
export * from "./dsh-cordis-host.js";
export * from "./endpoint-policy.js";
export * from "./host-runtime.js";
export * from "./http.js";
export * from "./manifest.js";
export * from "./invitation.js";
export * from "./participant.js";
export * from "./persistence.js";
export * from "./resume-credentials.js";
export * from "./repository-inspector.js";
export * from "./review-points.js";
export * from "./role.js";
export * from "./runtime.js";
export * from "./settings.js";
export * from "./ui.js";
export * from "./workspace-service.js";
export * from "./workspace-sharing.js";
export * from "./workspace-snapshot.js";
export * from "./workspace-snapshot-store.js";
export * from "./workspace-versions.js";
export * from "./workspace-version-transport.js";
export * from "./snapshot-workspace.js";
export * from "./work-updates.js";
export * from "./dsh-workspace-control.js";
export * from "./dsh-credentials.js";
export * from "./room-summary.js";

import { createDshRoomProjectSessionObserver, mountDshCollabCordisHost, resolveDshSessionWorkspacePath, type DshCordisHostConfig, type DshCordisHostContext, type DshSessionQuery } from "./dsh-cordis-host.js";
import { defaultCollabSettings, DSH_COLLAB_PARTICIPANT_NAMESPACE, DSH_COLLAB_PARTICIPANT_SCHEMA, DSH_COLLAB_SETTINGS_NAMESPACE, DSH_COLLAB_SETTINGS_SCHEMA, easyTierConfigFingerprint, validateDshCollabParticipantSettings, validateDshCollabPersistedSettings, type DshCollabPersistedSettings } from "./settings.js";
import { gatewayHttpUrl, normalizeGatewayEndpoint, privateGatewayEndpoint } from "./endpoint-policy.js";
import { HostSnapshotFile, resolveDefaultCollabRoomWorkspaceDir, resolveDefaultCollabSideTaskFile, resolveDefaultCollabSnapshotDir, resolveDefaultCollabStateFile } from "./persistence.js";
import { RepositoryInspector, createDshRepositoryCommandPort } from "./repository-inspector.js";
import { createDshLocalAgentSessionPort, type DshLocalAgentContext } from "./dsh-local-agent.js";
import type { DshAssistantStreamPayload } from "./dsh-assistant-stream.js";
import type { DshCordisSessionEventListener } from "./dsh-cordis-agent.js";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";
import { LocalSidecarService, type StartExplainTaskInput, type StartReviewTaskInput } from "./local-sidecar.js";
import { LocalSideTaskFile } from "./local-sidecar-store.js";
import { DshLocalSidecarWorkspace } from "./local-sidecar-workspace.js";
import { detectPrivateNetworkAddress } from "./network-address.js";
import { EasyTierRuntimeManager, createDshEasyTierProcessPort } from "./easytier-runtime.js";
import { DEFAULT_EASYTIER_OWNER_ADDRESS, EasyTierTransportCoordinator, type ActiveEasyTierTransport } from "./easytier-transport.js";
import { decodeEasyTierInvitationNetwork, type EasyTierInvitationNetwork } from "./easytier-invitation.js";
import { DshWorkspaceControl } from "./dsh-workspace-control.js";
import { DshCollabCredentialStore, type DshCredentialProvider } from "./dsh-credentials.js";
import { RoomProjectFile, RoomProjectStore, resolveDefaultRoomProjectFile } from "./room-projects.js";
import type { ParticipantResumeState } from "./dsh-browser-client.js";
import { DshRoomProjectRegistrar } from "./dsh-room-projects.js";
import { ParticipantRoomWorkspaceJoiner } from "./participant-room-join.js";
import { RoomWorkspaceMaterializer } from "./room-workspace.js";
import { WorkspaceSnapshotStore } from "./workspace-snapshot-store.js";
import { WorkspaceVersionClient } from "./workspace-version-transport.js";
import type { ParticipantGatewayTransport } from "./participant.js";
import { OwnerRoomProjectService } from "./owner-room-project.js";
import { OwnerRoomWorkspaceBootstrapper } from "./owner-room-bootstrap.js";

interface DshCollabSettingsScope {
  get(): DshCollabPersistedSettings;
  update(patch: object): Promise<void>;
}

/** Native DSH 0.2.x Config for the profile-owned dsh-collab host entry.
 * The collaboration settings are volatile so DSH SettingsForms exposes them
 * to the browser without making ordinary runtime identity fields editable.
 */
export const Config: z<Record<string, unknown>, Record<string, unknown>> = z.object({
  roomId: z.string().default("dsh-room"),
  hostId: z.string().required(),
  hostSessionId: z.string().default(""),
  title: z.string().default("DSH Collaboration"),
  hostDisplayName: z.string().required(),
  host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).default("0.0.0.0"),
  port: z.number().step(1).min(1).max(65535).default(4310),
  enabled: z.boolean().default(true),
  allowLoopbackPrincipal: z.boolean().default(true),
  gateway: z.object({
    gatewayHost: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]),
    gatewayPort: z.number().step(1).min(1).max(65535),
    exposeMode: z.union([z.const("loopback"), z.const("network")]),
    advertisedEndpoint: z.string().default(""),
  }).extra("volatile", true),
  appliedGateway: z.object({
    gatewayHost: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]),
    gatewayPort: z.number().step(1).min(1).max(65535),
    exposeMode: z.union([z.const("loopback"), z.const("network")]),
    advertisedEndpoint: z.string().default(""),
  }).hidden(),
  security: z.object({
    tokenTtlMs: z.union([z.number().step(1).min(1), z.const(null)]),
    approvalPolicy: z.union([z.const("host-only"), z.const("disabled")]),
    maxMembers: z.number().step(1).min(1),
    maxMessageBytes: z.number().step(1).min(1),
    maxQueue: z.number().step(1).min(0),
  }).extra("volatile", true),
  connectionMethod: z.union([z.const("unconfigured"), z.const("private-network"), z.const("easytier"), z.const("custom-wss")]).default("private-network").extra("volatile", true),
  easyTierSharedNode: z.string().default(defaultCollabSettings.easyTierSharedNode).extra("volatile", true),
  easyTierRooms: z.array(z.object({
    roomId: z.string().min(1).required(),
    credentialKey: z.string().min(1).required().hidden(),
    configFingerprint: z.string().min(1).default(undefined as unknown as string).hidden(),
  })).default([]).hidden(),
});

interface DshSettingsRegistrationContext {
  agents?: DshCordisHostContext["agents"];
  settings: {
    register?(namespace: string, schema: unknown, options: Record<string, unknown>): DshCollabSettingsScope;
  };
  connection?: { rpc: DshConnectionRpc };
  webServer?: unknown;
  sessionQuery?: DshSessionQuery;
}

interface DshConnectionRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
    options: { authority: "loopback" | "trusted-host" },
  ): () => Promise<void>;
}

export interface DshCollabCordisContext extends Omit<DshCordisHostContext, "agents"> {
  get?: (service: string) => unknown;
  agents: DshCordisHostContext["agents"] & Partial<DshLocalAgentContext["agents"]>;
  agentDefaultModel?: DshLocalAgentContext["agentDefaultModel"];
  agentPresets?: DshLocalAgentContext["agentPresets"];
  connection?: { rpc: DshConnectionRpc };
  effect?: (factory: () => (() => void | Promise<void>) | void, name?: string) => () => void | Promise<void>;
  inject?: (services: string[], callback: (context: DshSettingsRegistrationContext) => void) => unknown;
  easyTierTransport?: EasyTierTransportCoordinator;
  credentials?: DshCredentialProvider;
  workspaceRegistry?: {
    create(path: string, title?: string): Promise<{ readonly id: string; readonly path: string; attachSession(sessionId: string): Promise<void>; detachSession(sessionId: string): Promise<void> }>;
    list(): Array<{ readonly id: string; readonly path: string; attachSession(sessionId: string): Promise<void>; detachSession(sessionId: string): Promise<void> }>;
  };
}

type DshResolvedSettingsContext = DshCollabCordisContext & DshSettingsRegistrationContext;

function participantGatewayTransport(endpoint: string): ParticipantGatewayTransport {
  const base = gatewayHttpUrl(endpoint).replace(/\/$/, "");
  return {
    async request(input) {
      const response = await fetch(`${base}${input.path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${input.token}`,
          ...(input.capabilities?.length ? { "x-dsh-collab-capabilities": input.capabilities.join(",") } : {}),
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const envelope = await response.json() as { data?: unknown; error?: unknown };
      return { status: response.status, body: response.status >= 400 ? envelope.error : envelope.data };
    },
  };
}

function unwrapDshSettingsValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const candidate = value as { get?: unknown };
  if (typeof candidate.get === "function") return unwrapDshSettingsValue(candidate.get.call(value) as T);
  if (Array.isArray(value)) return value.map((item) => unwrapDshSettingsValue(item)) as T;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapDshSettingsValue(item)])) as T;
}

function unwrapDshCollabSettings(settings: DshCollabPersistedSettings): DshCollabPersistedSettings {
  return unwrapDshSettingsValue(settings);
}

function initialDshCollabSettings(config: Partial<DshCordisHostConfig>): DshCollabPersistedSettings {
  const source = config as Partial<DshCordisHostConfig> & Partial<DshCollabPersistedSettings>;
  const gatewayHost = config.host ?? source.gateway?.gatewayHost ?? defaultCollabSettings.gatewayHost;
  const gatewayPort = config.port ?? source.gateway?.gatewayPort ?? defaultCollabSettings.gatewayPort;
  const gateway = source.gateway ?? {
    gatewayHost,
    gatewayPort,
    exposeMode: gatewayHost === "127.0.0.1" ? "loopback" as const : "network" as const,
    advertisedEndpoint: "",
  };
  return {
    gateway,
    appliedGateway: source.appliedGateway ?? { ...gateway },
    security: source.security ?? {
      tokenTtlMs: config.tokenTtlMs === undefined ? defaultCollabSettings.tokenTtlMs : config.tokenTtlMs,
      approvalPolicy: config.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
      maxMembers: config.maxMembers ?? defaultCollabSettings.maxMembers,
      maxMessageBytes: config.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
      maxQueue: config.maxQueue ?? defaultCollabSettings.maxQueue,
    },
    connectionMethod: source.connectionMethod ?? defaultCollabSettings.connectionMethod,
    easyTierSharedNode: source.easyTierSharedNode ?? defaultCollabSettings.easyTierSharedNode,
    easyTierRooms: source.easyTierRooms ?? [],
  };
}

function mergeDshCollabSettings(current: DshCollabPersistedSettings, patch: object): DshCollabPersistedSettings {
  const resolvedCurrent = unwrapDshCollabSettings(current);
  const next = {
    ...resolvedCurrent,
    ...patch,
    gateway: { ...current.gateway, ...(patch as { gateway?: object }).gateway },
    appliedGateway: { ...current.appliedGateway, ...(patch as { appliedGateway?: object }).appliedGateway },
    security: { ...current.security, ...(patch as { security?: object }).security },
  } as DshCollabPersistedSettings;
  validateDshCollabPersistedSettings(next);
  return next;
}

export function registerDshCollabSettings(
  context: DshCollabCordisContext,
  config: Partial<DshCordisHostConfig>,
  onResolved?: (
    settings: DshCollabPersistedSettings,
    scope: DshCollabSettingsScope,
    settingsContext: DshResolvedSettingsContext,
  ) => void,
): void {
  const register = (settingsContext: DshResolvedSettingsContext): void => {
    const legacyRegister = settingsContext.settings.register;
    if (legacyRegister) {
      const scope = legacyRegister.call(settingsContext.settings, DSH_COLLAB_SETTINGS_NAMESPACE, DSH_COLLAB_SETTINGS_SCHEMA, {
        base: initialDshCollabSettings(config),
        applies: "restart",
        validate: validateDshCollabPersistedSettings,
      });
      legacyRegister.call(settingsContext.settings, DSH_COLLAB_PARTICIPANT_NAMESPACE, DSH_COLLAB_PARTICIPANT_SCHEMA, {
        validate: validateDshCollabParticipantSettings,
      });
      onResolved?.(unwrapDshCollabSettings(scope.get()), scope, settingsContext);
      return;
    }

    // DSH 0.1.7 exposes SettingsForms instead of the removed registry API.
    // The plugin config is the source of truth for this compatibility path;
    // keep a validated in-memory scope for the Gateway lifecycle until the
    // plugin is migrated to a native Config schema and settings form.
    let current = initialDshCollabSettings(config);
    const scope: DshCollabSettingsScope = {
      get: () => current,
      update: async (patch) => {
        current = mergeDshCollabSettings(current, patch);
      },
    };
    onResolved?.(current, scope, settingsContext);
  };
  if (context.settings) {
    register({ ...context, settings: context.settings } as DshResolvedSettingsContext);
    return;
  }
  context.inject?.(["settings"], (settingsContext) => {
    register({ ...context, ...settingsContext } as DshResolvedSettingsContext);
  });
}

function applyPersistedSettings(config: Partial<DshCordisHostConfig>, settings: DshCollabPersistedSettings): Partial<DshCordisHostConfig> {
  const security = settings.security ?? defaultCollabSettings;
  return {
    ...config,
    host: settings.gateway.gatewayHost,
    port: settings.gateway.gatewayPort,
    tokenTtlMs: security.tokenTtlMs,
    // MVP approval is always delegated to DSH's native Host approval chain.
    approvalPolicy: "host-only",
    allowLoopbackPrincipal: config.allowLoopbackPrincipal ?? true,
    trustedLoopbackOrigins: config.trustedLoopbackOrigins ?? ["dsh-app://app"],
    maxMembers: security.maxMembers,
    maxMessageBytes: security.maxMessageBytes,
    maxQueue: security.maxQueue,
  };
}

function registerGatewayControl(
  context: DshCollabCordisContext,
  config: Partial<DshCordisHostConfig>,
  scope: ReturnType<NonNullable<DshSettingsRegistrationContext["settings"]["register"]>>,
): void {
  if (!context.connection || typeof config.hostId !== "string" || typeof config.hostDisplayName !== "string") return;
  let mounted: ReturnType<typeof mountDshCollabCordisHost>;
  let runningAdvertisedEndpoint: string | undefined;
  let starting: Promise<{ status: "running"; port: number; advertisedEndpoint?: string }> | undefined;
  const injectedEasyTier = (context.get
    ? context.get("easyTierTransport")
    : context.easyTierTransport) as EasyTierTransportCoordinator | undefined;
  const easyTier = injectedEasyTier ?? (context.subprocess
    ? new EasyTierTransportCoordinator({ runtime: new EasyTierRuntimeManager({ processes: createDshEasyTierProcessPort(context.subprocess) }) })
    : undefined);
  const credentialStore = context.credentials ? new DshCollabCredentialStore(context.credentials) : undefined;
  const createLocalAgent = context.agents.create;
  const sideTaskPersistence = config.sideTaskFile === false || (config.sideTaskFile === undefined && config.stateFile === false)
    ? undefined
    : new LocalSideTaskFile(config.sideTaskFile ?? resolveDefaultCollabSideTaskFile());
  const sidecar = context.agentDefaultModel && context.agentPresets && context.on && createLocalAgent
    ? new LocalSidecarService(createDshLocalAgentSessionPort({
        agentDefaultModel: context.agentDefaultModel,
        installModelSelection: (agentContext, selection) => {
          installModelSelection(agentContext as Parameters<typeof installModelSelection>[0], selection);
        },
        agents: { create: (input) => createLocalAgent.call(context.agents, input) },
        agentPresets: context.agentPresets,
        on: ((event: "session/event" | "agent/assistant-stream", listener: unknown) => {
          if (event === "session/event") return context.on!(event, listener as DshCordisSessionEventListener);
          return context.on!(event, listener as (payload: DshAssistantStreamPayload<object>) => void);
        }) as DshLocalAgentContext["on"],
      }), {
        snapshot: sideTaskPersistence?.loadSync(),
        workspace: new DshLocalSidecarWorkspace({
          local: (roomId) => {
            if (!mounted?.workspaceSnapshots) return undefined;
            const room = mounted.runtime.rooms.getRoom(roomId);
            return {
              provider: mounted.workspaceSnapshots,
              hostSessionId: room.hostSessionId,
              roomEventSeq: mounted.runtime.ledger.latestSeq(roomId),
            };
          },
        }),
      })
    : undefined;
  const roomProjectFile = config.stateFile === false
    ? undefined
    : new RoomProjectFile(resolveDefaultRoomProjectFile());
  const roomProjectSnapshot = roomProjectFile?.loadSync();
  const roomProjects = roomProjectSnapshot
    ? RoomProjectStore.fromSnapshot(roomProjectSnapshot)
    : new RoomProjectStore();
  const roomWorkspaceArtifacts = new WorkspaceSnapshotStore(resolveDefaultCollabSnapshotDir());
  const roomProjectRegistrar = roomProjectFile && context.workspaceRegistry?.create
    ? new DshRoomProjectRegistrar({
        store: roomProjects,
        persistence: roomProjectFile,
        workspaces: {
          create: async (path, title) => ({ workspaceId: (await context.workspaceRegistry!.create(path, title)).id }),
        },
      })
    : undefined;
  const ownerRoomProject = (): OwnerRoomProjectService | undefined => {
    const current = mounted;
    if (!current?.workspaceSnapshots || !current.runtime.workspaceVersions || !roomProjectRegistrar) return undefined;
    return new OwnerRoomProjectService({
      hostId: config.hostId!,
      hostDisplayName: config.hostDisplayName!,
      sessions: { workspacePath: (sessionId) => resolveDshSessionWorkspacePath({ agents: context.agents, sessions: context.sessions, sessionQuery: context.sessionQuery }, sessionId) },
      rooms: current.runtime.rooms,
      roomProjects,
      ledger: current.runtime.ledger,
      workspace: current.runtime.workspace,
      workspaceVersions: current.runtime.workspaceVersions,
      bootstrap: new OwnerRoomWorkspaceBootstrapper({
        materializer: new RoomWorkspaceMaterializer({ root: resolveDefaultCollabRoomWorkspaceDir(), artifacts: roomWorkspaceArtifacts }),
        registrar: roomProjectRegistrar,
      }),
      commitCriticalState: () => current.runtime.commitCriticalState(),
    });
  };
  const participantRoomProjectAvailable = roomProjectRegistrar !== undefined;
  const roomProjectObserver = createDshRoomProjectSessionObserver({ context, projects: roomProjects });
  roomProjectObserver.start();
  const workspaceControl = context.subprocess ? new DshWorkspaceControl({
    subprocess: context.subprocess,
    agents: context.agents,
    roomProjects,
  }) : undefined;
  const saveSideTasks = (): void => {
    if (sidecar && sideTaskPersistence) void sideTaskPersistence.save(sidecar.snapshot()).catch((error: unknown) => console.warn("dsh-collab local SideTask save failed", error));
  };
  const unsubscribeSideTasks = sidecar && sideTaskPersistence ? sidecar.subscribe(saveSideTasks) : undefined;
  saveSideTasks();

  const stop = async (): Promise<{ status: "stopped" }> => {
    await starting?.catch(() => undefined);
    const current = mounted;
    mounted = undefined;
    await Promise.all([current?.dispose(), easyTier?.stop()]);
    runningAdvertisedEndpoint = undefined;
    return { status: "stopped" };
  };
  const start = async (): Promise<{ status: "running"; port: number; advertisedEndpoint?: string }> => {
    if (mounted && !starting) {
      const port = await mounted.ready;
      return { status: "running", port, ...(runningAdvertisedEndpoint ? { advertisedEndpoint: runningAdvertisedEndpoint } : {}) };
    }
    if (starting) return await starting;
    starting = (async () => {
      const settings = unwrapDshCollabSettings(scope.get());
      const next = mountDshCollabCordisHost(context, applyPersistedSettings(config, settings) as DshCordisHostConfig);
      if (!next) throw new Error("Host Gateway is disabled");
      mounted = next;
      try {
        const gatewayPort = await next.ready;
        const advertisedEndpoint = settings.connectionMethod === "easytier"
          ? privateGatewayEndpoint(DEFAULT_EASYTIER_OWNER_ADDRESS, gatewayPort)
          : settings.gateway.exposeMode === "network"
          ? privateGatewayEndpoint(detectPrivateNetworkAddress() || (() => { throw new Error("No private network address is available") })(), gatewayPort)
          : settings.gateway.advertisedEndpoint;
        // Keep an empty advertisedEndpoint empty so the next start can detect
        // the current LAN address again instead of treating this result as a
        // user-pinned address. The hidden applied snapshot is the runtime
        // result shown in invitations and diagnostics.
        const configuredGateway = { ...settings.gateway, gatewayPort, advertisedEndpoint: settings.gateway.exposeMode === "network" ? "" : settings.gateway.advertisedEndpoint };
        const appliedGateway = { ...configuredGateway, advertisedEndpoint };
        await scope.update({ gateway: configuredGateway, appliedGateway });
        runningAdvertisedEndpoint = advertisedEndpoint;
        return { status: "running", port: gatewayPort, advertisedEndpoint };
      } catch (error) {
        if (mounted === next) mounted = undefined;
        runningAdvertisedEndpoint = undefined;
        await next.dispose().catch(() => undefined);
        throw error;
      }
    })();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  };
  const listOwnedRooms = (): Array<{ roomId: string; hostSessionId: string; title: string; sharing: boolean; workspacePath?: string; sourcePath?: string }> => {
    const rooms = mounted?.runtime.rooms.snapshot()
      ?? (config.stateFile === false ? undefined : new HostSnapshotFile(config.stateFile ?? resolveDefaultCollabStateFile()).loadSync()?.rooms);
    return (rooms?.rooms ?? []).filter(({ room }) => {
      const project = roomProjects.get(room.roomId);
      return !project || project.hostPrimarySessionId === room.hostSessionId;
    }).map(({ room }) => {
      const project = roomProjects.get(room.roomId);
      return {
        roomId: room.roomId,
        hostSessionId: room.hostSessionId,
        title: room.title,
        sharing: mounted?.runtime.activeRooms.isActive(room.roomId) ?? false,
        ...(project?.workspacePath ? { workspacePath: project.workspacePath } : {}),
        ...(project?.sourcePath ? { sourcePath: project.sourcePath } : {}),
      };
    });
  };
  const ownerEasyTierNetwork = async (roomId: string, gatewayPort: number, signal: AbortSignal): Promise<ActiveEasyTierTransport> => {
    if (!easyTier) throw new Error("EasyTier is unavailable on this DSH runtime");
    if (!credentialStore) throw new Error("DSH credentials service is unavailable");
    const settings = unwrapDshCollabSettings(scope.get());
    if (settings.connectionMethod !== "easytier") throw new Error("Select EasyTier virtual network before sharing this room");
    const configFingerprint = easyTierConfigFingerprint(settings);
    const savedRoom = settings.easyTierRooms?.find((room) => room.roomId === roomId);
    const saved = savedRoom?.configFingerprint === configFingerprint ? savedRoom.credentialKey : undefined;
    const network = saved ? await credentialStore.loadOwnerNetwork(saved) : undefined;
    const active = await easyTier.startOwner({
      roomId,
      gatewayPort,
      ...(network ? { network } : { sharedNode: settings.easyTierSharedNode ?? defaultCollabSettings.easyTierSharedNode }),
      signal,
    });
    if (!saved) {
      const credentialKey = await credentialStore.saveOwnerNetwork(active.network);
      const easyTierRooms = [...(settings.easyTierRooms ?? []).filter((room) => room.roomId !== roomId), { roomId, credentialKey, configFingerprint }];
      try { await scope.update({ easyTierRooms }); }
      catch (error) { await credentialStore.deleteOwnerNetwork(credentialKey).catch(() => undefined); throw error; }
      if (savedRoom?.credentialKey && savedRoom.credentialKey !== credentialKey) await credentialStore.deleteOwnerNetwork(savedRoom.credentialKey).catch(() => undefined);
    }
    return active;
  };
  const activeRepository = (payload: unknown): { inspector: RepositoryInspector; input: Record<string, unknown> } => {
    if (!mounted || !context.subprocess) throw new Error("Host Gateway repository inspection is unavailable");
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as { roomId?: unknown }).roomId !== "string") {
      throw new Error("roomId is required");
    }
    const input = payload as Record<string, unknown>;
    const roomId = (input.roomId as string).trim();
    if (roomId === "" || !mounted.runtime.activeRooms.isActive(roomId)) throw new Error("Owned room is not being shared");
    const room = mounted.runtime.rooms.getRoom(roomId);
    const cwd = context.agents.get(room.hostSessionId)?.session?.header?.cwd;
    if (!cwd) throw new Error("Host session does not expose a workspace path");
    return { inspector: new RepositoryInspector(createDshRepositoryCommandPort({ subprocess: context.subprocess, cwd })), input };
  };
  const removeControl = context.connection.rpc.handle("/dsh-collab", async (endpoint, payload, signal) => {
    try {
      if (endpoint === "gateway/status") {
        if (starting) return { ok: true, value: { status: "starting" } };
        if (mounted) {
          const port = await mounted.ready;
          return { ok: true, value: { status: "running", port, ...(runningAdvertisedEndpoint ? { advertisedEndpoint: runningAdvertisedEndpoint } : {}) } };
        }
        return { ok: true, value: { status: "stopped" } };
      }
      if (endpoint === "gateway/start") return { ok: true, value: await start() };
      if (endpoint === "gateway/stop") return { ok: true, value: await stop() };
      if (endpoint === "easytier/status") return { ok: true, value: easyTier?.snapshot() ?? { active: false, runtime: { kind: "idle" } } };
      if (endpoint === "easytier/owner/start") {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("EasyTier Owner request is invalid");
        const input = payload as { roomId?: unknown; gatewayPort?: unknown };
        if (typeof input.roomId !== "string" || !Number.isSafeInteger(input.gatewayPort)) throw new Error("EasyTier Owner request is invalid");
        return { ok: true, value: await ownerEasyTierNetwork(input.roomId, input.gatewayPort as number, signal) };
      }
      if (endpoint === "easytier/participant/start") {
        if (!easyTier || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("EasyTier Participant request is invalid");
        const input = payload as { roomId?: unknown; gatewayPort?: unknown; network?: unknown; localVirtualAddress?: unknown };
        if (typeof input.roomId !== "string" || !Number.isSafeInteger(input.gatewayPort)) throw new Error("EasyTier Participant request is invalid");
        const network: EasyTierInvitationNetwork = decodeEasyTierInvitationNetwork(input.network);
        const value = await easyTier.startParticipant({
          roomId: input.roomId,
          gatewayPort: input.gatewayPort as number,
          network,
          ...(typeof input.localVirtualAddress === "string" ? { localVirtualAddress: input.localVirtualAddress } : {}),
          signal,
        });
        return { ok: true, value };
      }
      if (endpoint === "easytier/stop") return { ok: true, value: await easyTier?.stop() ?? { kind: "idle" } };
      if (endpoint === "credentials/participant/save") {
        if (!credentialStore || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Participant credential request is invalid");
        const credentialKey = await credentialStore.saveParticipant((payload as { state?: unknown }).state as ParticipantResumeState);
        return { ok: true, value: { credentialKey } };
      }
      if (endpoint === "credentials/participant/load") {
        if (!credentialStore || !payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as { credentialKey?: unknown }).credentialKey !== "string") throw new Error("Participant credential request is invalid");
        const state = await credentialStore.loadParticipant((payload as { credentialKey: string }).credentialKey);
        return { ok: true, value: { state } };
      }
      if (endpoint === "credentials/participant/delete") {
        if (!credentialStore || !payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as { credentialKey?: unknown }).credentialKey !== "string") throw new Error("Participant credential request is invalid");
        await credentialStore.deleteParticipant((payload as { credentialKey: string }).credentialKey);
        return { ok: true, value: { deleted: true } };
      }
      if (endpoint === "rooms/list") return { ok: true, value: { rooms: listOwnedRooms() } };
      if (endpoint === "owner/room-project/prepare" || endpoint === "owner/room-project/complete") {
        let service = ownerRoomProject();
        if (!service && endpoint.endsWith("/prepare") && roomProjectFile && context.workspaceRegistry?.create) {
          await start();
          service = ownerRoomProject();
        }
        if (!service) throw new Error("Owner Room Project is unavailable");
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Owner Room Project request is invalid");
        const value = endpoint.endsWith("/prepare")
          ? await service.prepare(payload as { sourcePath: string; sourceSessionId: string; roomTitle: string })
          : await service.complete(payload as { roomId: string; sourceSessionId: string; hostPrimarySessionId: string });
        return { ok: true, value };
      }
      if (endpoint === "participant/room-project/summary") {
        if (!participantRoomProjectAvailable) throw new Error("Participant Room Project is unavailable");
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Participant Room Project request is invalid");
        const input = payload as { roomId?: unknown; gatewayEndpoint?: unknown; roomToken?: unknown };
        if ([input.roomId, input.gatewayEndpoint, input.roomToken].some((value) => typeof value !== "string" || value.trim() === "")) {
          throw new Error("Participant Room Project request is invalid");
        }
        const gatewayEndpoint = normalizeGatewayEndpoint(input.gatewayEndpoint as string);
        const versions = new WorkspaceVersionClient({ transport: participantGatewayTransport(gatewayEndpoint), artifacts: roomWorkspaceArtifacts });
        const summary = await versions.getLatestSummary({ roomId: (input.roomId as string).trim(), token: input.roomToken as string });
        return { ok: true, value: {
          roomId: (input.roomId as string).trim(),
          fileCount: summary.fileCount,
          totalBytes: summary.totalBytes,
        } };
      }
      if (endpoint === "participant/room-project/join") {
        if (!participantRoomProjectAvailable) throw new Error("Participant Room Project is unavailable");
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Participant Room Project request is invalid");
        const input = payload as { roomId?: unknown; memberId?: unknown; roomTitle?: unknown; gatewayEndpoint?: unknown; roomToken?: unknown };
        if ([input.roomId, input.memberId, input.roomTitle, input.gatewayEndpoint, input.roomToken].some((value) => typeof value !== "string" || value.trim() === "")) {
          throw new Error("Participant Room Project request is invalid");
        }
        const gatewayEndpoint = normalizeGatewayEndpoint(input.gatewayEndpoint as string);
        const joiner = new ParticipantRoomWorkspaceJoiner({
          versions: new WorkspaceVersionClient({ transport: participantGatewayTransport(gatewayEndpoint), artifacts: roomWorkspaceArtifacts }),
          materializer: new RoomWorkspaceMaterializer({ root: resolveDefaultCollabRoomWorkspaceDir(), artifacts: roomWorkspaceArtifacts }),
          registrar: roomProjectRegistrar!,
        });
        const result = await joiner.join({
          roomId: (input.roomId as string).trim(),
          memberId: (input.memberId as string).trim(),
          roomTitle: (input.roomTitle as string).trim(),
          token: input.roomToken as string,
        });
        if (!result.project.nativeWorkspaceId) throw new Error("Participant Room Project native Workspace is missing");
        return { ok: true, value: {
          roomId: result.project.roomId,
          memberId: result.project.memberId,
          roomTitle: result.project.roomTitle,
          workspacePath: result.workspace.workspacePath,
          nativeWorkspaceId: result.project.nativeWorkspaceId,
          fileCount: result.workspace.record.version.files.length,
          totalBytes: result.workspace.record.artifact.totalBytes,
        } };
      }
      if (endpoint === "sidecar/start") {
        if (!sidecar) throw new Error("Local Sidecar Agent is unavailable");
        return { ok: true, value: { sideTask: await sidecar.startExplain(payload as StartExplainTaskInput) } };
      }
      if (endpoint === "sidecar/start-review") {
        if (!sidecar) throw new Error("Local Sidecar Agent is unavailable");
        return { ok: true, value: { sideTask: await sidecar.startReview(payload as StartReviewTaskInput) } };
      }
      if (endpoint === "sidecar/get") {
        if (!sidecar) throw new Error("Local Sidecar Agent is unavailable");
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as { roomId?: unknown }).roomId !== "string") throw new Error("roomId is required");
        return { ok: true, value: { sideTask: sidecar.get((payload as { roomId: string }).roomId) ?? null } };
      }
      if (endpoint === "sidecar/cancel") {
        if (!sidecar) throw new Error("Local Sidecar Agent is unavailable");
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("roomId and taskId are required");
        const input = payload as { roomId?: unknown; taskId?: unknown };
        if (typeof input.roomId !== "string" || typeof input.taskId !== "string") throw new Error("roomId and taskId are required");
        return { ok: true, value: { sideTask: await sidecar.cancel(input.roomId, input.taskId) } };
      }
      if (endpoint === "sidecar/mark-published") {
        if (!sidecar) throw new Error("Local Sidecar Agent is unavailable");
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Local SideTask publication is invalid");
        const input = payload as { roomId?: unknown; taskId?: unknown; publicationId?: unknown; publishedAt?: unknown };
        if (typeof input.roomId !== "string" || typeof input.taskId !== "string" || typeof input.publicationId !== "string"
          || typeof input.publishedAt !== "number") throw new Error("Local SideTask publication is invalid");
        return { ok: true, value: { sideTask: sidecar.markPublished(input.roomId, input.taskId, input.publicationId, input.publishedAt) } };
      }
      if (endpoint === "repository/inspect") {
        const { inspector } = activeRepository(payload);
        const inspection = await inspector.inspect(signal);
        return { ok: true, value: { inspection } };
      }
      if (endpoint === "repository/diff") {
        const { inspector, input } = activeRepository(payload);
        if (typeof input.path !== "string" || (input.layer !== "staged" && input.layer !== "unstaged")) throw new Error("path and layer are required");
        const diff = await inspector.diff({ path: input.path, layer: input.layer }, signal);
        return { ok: true, value: { diff } };
      }
      if (endpoint.startsWith("workspace/")) {
        if (!workspaceControl) throw new Error("Collab Workspace is unavailable");
        return { ok: true, value: await workspaceControl.handle(endpoint, payload, signal) };
      }
      return { ok: false, error: { code: "bad-request", message: `Unknown dsh-collab control endpoint: ${endpoint}`, details: { issues: [] } } };
    } catch (error) {
      return { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error), details: {} } };
    }
  }, { authority: "loopback" });
  context.effect?.(() => async () => {
    await removeControl();
    roomProjectObserver.dispose();
    await Promise.all([stop(), sidecar?.dispose(), workspaceControl?.dispose()]);
    unsubscribeSideTasks?.();
    await sideTaskPersistence?.flush();
  }, "dsh-collab: Gateway control");
}

/**
 * Host entry point for a DSH Cordis row. Room/session fields are deliberately
 * opt-in: a profile that only installs the browser face cannot accidentally
 * create a room without a trusted local Agent session.
 */
export function apply(context?: DshCollabCordisContext, config?: Partial<DshCordisHostConfig>): void {
  if (!context || !config) return;
  if (config.enabled === false) {
    registerDshCollabSettings(context, config);
    return;
  }
  registerDshCollabSettings(context, config, (_settings, scope, settingsContext) => {
    if (context.inject) {
      context.inject(["connection", "webServer", "sessions", "sessionQuery", "workspaceRegistry"], (runtimeContext) => {
        const gatewayContext = runtimeContext.connection && runtimeContext.webServer
          ? Object.assign(Object.create(context), runtimeContext)
          : settingsContext.connection
          ? settingsContext
          : context;
        registerGatewayControl(gatewayContext as DshCollabCordisContext, config, scope);
      });
      return;
    }
    registerGatewayControl((settingsContext.connection ? settingsContext : context) as DshCollabCordisContext, config, scope);
  });
}

export * from "./easytier-artifacts.js";
export * from "./easytier-invitation.js";
export * from "./easytier-runtime.js";
export * from "./easytier-transport.js";
