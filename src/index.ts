export * from "./approvals.js";
export * from "./active-rooms.js";
export * from "./audit.js";
export * from "./room-client.js";
export * from "./gateway.js";
export * from "./dsh-host.js";
export * from "./dsh-local-agent.js";
export * from "./collaboration-types.js";
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
export * from "./role.js";
export * from "./runtime.js";
export * from "./settings.js";
export * from "./ui.js";
export * from "./workspace-service.js";
export * from "./workspace-sharing.js";

import { mountDshCollabCordisHost, type DshCordisHostConfig, type DshCordisHostContext } from "./dsh-cordis-host.js";
import { defaultCollabSettings, DSH_COLLAB_PARTICIPANT_NAMESPACE, DSH_COLLAB_PARTICIPANT_SCHEMA, DSH_COLLAB_SETTINGS_NAMESPACE, DSH_COLLAB_SETTINGS_SCHEMA, validateDshCollabParticipantSettings, validateDshCollabPersistedSettings, type DshCollabPersistedSettings } from "./settings.js";
import { privateAddressFromGatewayEndpoint, privateGatewayEndpoint } from "./endpoint-policy.js";
import { HostSnapshotFile, resolveDefaultCollabStateFile } from "./persistence.js";

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

export interface DshCollabCordisContext extends DshCordisHostContext {
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
          tokenTtlMs: config.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs,
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
    approvalPolicy: security.approvalPolicy,
    maxMembers: security.maxMembers,
    maxMessageBytes: security.maxMessageBytes,
    maxQueue: security.maxQueue,
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
          ? privateGatewayEndpoint(privateAddressFromGatewayEndpoint(settings.gateway.advertisedEndpoint), gatewayPort)
          : settings.gateway.advertisedEndpoint;
        const appliedGateway = { ...settings.gateway, gatewayPort, advertisedEndpoint };
        await scope.update({ gateway: appliedGateway, appliedGateway });
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

  const removeControl = context.connection.rpc.handle("/dsh-collab", async (endpoint) => {
    try {
      if (endpoint === "gateway/status") {
        if (starting) return { ok: true, value: { status: "starting" } };
        if (mounted) return { ok: true, value: { status: "running", port: await mounted.ready } };
        return { ok: true, value: { status: "stopped" } };
      }
      if (endpoint === "gateway/start") return { ok: true, value: await start() };
      if (endpoint === "gateway/stop") return { ok: true, value: await stop() };
      if (endpoint === "rooms/list") return { ok: true, value: { rooms: listOwnedRooms() } };
      return { ok: false, error: { code: "bad-request", message: `Unknown dsh-collab control endpoint: ${endpoint}`, details: { issues: [] } } };
    } catch (error) {
      return { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error), details: {} } };
    }
  }, { authority: "loopback" });
  context.effect?.(() => async () => {
    await removeControl();
    await stop();
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
