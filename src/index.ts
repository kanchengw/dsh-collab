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

import { mountDshCollabCordisHost, type DshCordisHostConfig, type DshCordisHostContext } from "./dsh-cordis-host.js";
import { defaultCollabSettings, DSH_COLLAB_PARTICIPANT_NAMESPACE, DSH_COLLAB_PARTICIPANT_SCHEMA, DSH_COLLAB_SETTINGS_NAMESPACE, DSH_COLLAB_SETTINGS_SCHEMA, migrateLegacyMaxQueue, validateDshCollabParticipantSettings, validateDshCollabPersistedSettings, type DshCollabPersistedSettings } from "./settings.js";
import { privateGatewayEndpoint } from "./endpoint-policy.js";
import { HostSnapshotFile, resolveDefaultCollabSideTaskFile, resolveDefaultCollabStateFile } from "./persistence.js";
import { RepositoryInspector, createDshRepositoryCommandPort } from "./repository-inspector.js";
import { createDshLocalAgentSessionPort, type DshLocalAgentContext } from "./dsh-local-agent.js";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { LocalSidecarService, type StartExplainTaskInput, type StartReviewTaskInput } from "./local-sidecar.js";
import { LocalSideTaskFile } from "./local-sidecar-store.js";
import { DshLocalSidecarWorkspace } from "./local-sidecar-workspace.js";
import { detectPrivateNetworkAddress } from "./network-address.js";

interface DshSettingsRegistrationContext {
  settings: {
    register(namespace: string, schema: unknown, options: Record<string, unknown>): {
      get(): DshCollabPersistedSettings;
      update(patch: object): Promise<void>;
    };
  };
}

interface DshConnectionRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
    options: { authority: "loopback" | "trusted-host" },
  ): () => Promise<void>;
}

export interface DshCollabCordisContext extends Omit<DshCordisHostContext, "agents"> {
  agents: DshCordisHostContext["agents"] & Partial<DshLocalAgentContext["agents"]>;
  agentDefaultModel?: DshLocalAgentContext["agentDefaultModel"];
  agentPresets?: DshLocalAgentContext["agentPresets"];
  connection?: { rpc: DshConnectionRpc };
  effect?: (factory: () => (() => void | Promise<void>) | void, name?: string) => () => void | Promise<void>;
  inject?: (services: string[], callback: (context: DshSettingsRegistrationContext) => void) => unknown;
}

export function registerDshCollabSettings(
  context: DshCollabCordisContext,
  config: Partial<DshCordisHostConfig>,
  onResolved?: (settings: DshCollabPersistedSettings, scope: ReturnType<DshSettingsRegistrationContext["settings"]["register"]>) => void,
): void {
  const gatewayHost = config.host ?? "127.0.0.1";
  context.inject?.(["settings"], (settingsContext) => {
    const scope = settingsContext.settings.register(DSH_COLLAB_SETTINGS_NAMESPACE, DSH_COLLAB_SETTINGS_SCHEMA, {
      base: {
        gateway: {
          gatewayHost,
          gatewayPort: config.port ?? defaultCollabSettings.gatewayPort,
          exposeMode: gatewayHost === "127.0.0.1" ? "loopback" : "network",
          advertisedEndpoint: "",
        },
        appliedGateway: {
          gatewayHost,
          gatewayPort: config.port ?? defaultCollabSettings.gatewayPort,
          exposeMode: gatewayHost === "127.0.0.1" ? "loopback" : "network",
          advertisedEndpoint: "",
        },
        security: {
          tokenTtlMs: config.tokenTtlMs === undefined ? defaultCollabSettings.tokenTtlMs : config.tokenTtlMs,
          approvalPolicy: config.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
          maxMembers: config.maxMembers ?? defaultCollabSettings.maxMembers,
          maxMessageBytes: config.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
          maxQueue: config.maxQueue ?? defaultCollabSettings.maxQueue,
        },
      },
      applies: "restart",
      validate: validateDshCollabPersistedSettings,
    });
    settingsContext.settings.register(DSH_COLLAB_PARTICIPANT_NAMESPACE, DSH_COLLAB_PARTICIPANT_SCHEMA, {
      validate: validateDshCollabParticipantSettings,
    });
    onResolved?.(scope.get(), scope);
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
    maxMembers: security.maxMembers,
    maxMessageBytes: security.maxMessageBytes,
    maxQueue: migrateLegacyMaxQueue(security.maxQueue),
  };
}

function registerGatewayControl(
  context: DshCollabCordisContext,
  config: Partial<DshCordisHostConfig>,
  scope: ReturnType<DshSettingsRegistrationContext["settings"]["register"]>,
): void {
  if (!context.connection || typeof config.hostId !== "string" || typeof config.hostDisplayName !== "string") return;
  let mounted: ReturnType<typeof mountDshCollabCordisHost>;
  let starting: Promise<{ status: "running"; port: number }> | undefined;
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
        on: (event, listener) => context.on!(event, listener),
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
  const saveSideTasks = (): void => {
    if (sidecar && sideTaskPersistence) void sideTaskPersistence.save(sidecar.snapshot()).catch((error: unknown) => console.warn("dsh-collab local SideTask save failed", error));
  };
  const unsubscribeSideTasks = sidecar && sideTaskPersistence ? sidecar.subscribe(saveSideTasks) : undefined;
  saveSideTasks();

  const stop = async (): Promise<{ status: "stopped" }> => {
    await starting?.catch(() => undefined);
    const current = mounted;
    mounted = undefined;
    if (current) await current.dispose();
    return { status: "stopped" };
  };
  const start = async (): Promise<{ status: "running"; port: number }> => {
    if (mounted && !starting) return { status: "running", port: await mounted.ready };
    if (starting) return await starting;
    starting = (async () => {
      const settings = scope.get();
      const next = mountDshCollabCordisHost(context, applyPersistedSettings(config, settings) as DshCordisHostConfig);
      if (!next) throw new Error("Host Gateway is disabled");
      mounted = next;
      try {
        const gatewayPort = await next.ready;
        const advertisedEndpoint = settings.gateway.exposeMode === "network"
          ? privateGatewayEndpoint(detectPrivateNetworkAddress() || (() => { throw new Error("No private network address is available") })(), gatewayPort)
          : settings.gateway.advertisedEndpoint;
        // Keep an empty advertisedEndpoint empty so the next start can detect
        // the current LAN address again instead of treating this result as a
        // user-pinned address. The hidden applied snapshot is the runtime
        // result shown in invitations and diagnostics.
        const configuredGateway = { ...settings.gateway, gatewayPort, advertisedEndpoint: settings.gateway.exposeMode === "network" ? "" : settings.gateway.advertisedEndpoint };
        const appliedGateway = { ...configuredGateway, advertisedEndpoint };
        await scope.update({ gateway: configuredGateway, appliedGateway });
        return { status: "running", port: gatewayPort };
      } catch (error) {
        if (mounted === next) mounted = undefined;
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
  const listOwnedRooms = (): Array<{ roomId: string; hostSessionId: string; title: string; sharing: boolean }> => {
    const rooms = mounted?.runtime.rooms.snapshot()
      ?? (config.stateFile === false ? undefined : new HostSnapshotFile(config.stateFile ?? resolveDefaultCollabStateFile()).loadSync()?.rooms);
    return (rooms?.rooms ?? []).map(({ room }) => ({
      roomId: room.roomId,
      hostSessionId: room.hostSessionId,
      title: room.title,
      sharing: mounted?.runtime.activeRooms.isActive(room.roomId) ?? false,
    }));
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
        if (mounted) return { ok: true, value: { status: "running", port: await mounted.ready } };
        return { ok: true, value: { status: "stopped" } };
      }
      if (endpoint === "gateway/start") return { ok: true, value: await start() };
      if (endpoint === "gateway/stop") return { ok: true, value: await stop() };
      if (endpoint === "rooms/list") return { ok: true, value: { rooms: listOwnedRooms() } };
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
      return { ok: false, error: { code: "bad-request", message: `Unknown dsh-collab control endpoint: ${endpoint}`, details: { issues: [] } } };
    } catch (error) {
      return { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error), details: {} } };
    }
  }, { authority: "loopback" });
  context.effect?.(() => async () => {
    await removeControl();
    await Promise.all([stop(), sidecar?.dispose()]);
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
  if (context.inject) registerDshCollabSettings(context, config, (_settings, scope) => {
    registerGatewayControl(context, config, scope);
  });
}

export default apply;
export * from "./easytier-artifacts.js";
export * from "./easytier-runtime.js";
