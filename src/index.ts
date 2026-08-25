export * from "./approvals.js";
export * from "./audit.js";
export * from "./room-client.js";
export * from "./gateway.js";
export * from "./dsh-host.js";
export * from "./dsh-cordis-agent.js";
export * from "./dsh-cordis-host.js";
export * from "./dsh-client.js";
export * from "./dsh-browser-client.js";
export * from "./host-runtime.js";
export * from "./http.js";
export * from "./manifest.js";
export * from "./nginx.js";
export * from "./participant.js";
export * from "./role.js";
export * from "./runtime.js";
export * from "./settings.js";
export * from "./ui.js";
export * from "./webserver.js";

import { mountDshCollabCordisHost, type DshCordisHostConfig, type DshCordisHostContext } from "./dsh-cordis-host.js";
import { createLocalNginxProxy, resolveDshPort, resolveLocalProxyPort, type LocalNginxProxy } from "./nginx.js";
import { defaultCollabSettings, DSH_COLLAB_SETTINGS_NAMESPACE, DSH_COLLAB_SETTINGS_SCHEMA, validateDshCollabPersistedSettings } from "./settings.js";

interface DshSettingsRegistrationContext {
  settings: {
    register(namespace: string, schema: unknown, options: Record<string, unknown>): unknown;
  };
}

export interface DshCollabCordisContext extends DshCordisHostContext {
  effect?: (factory: () => (() => void) | void, name?: string) => () => void;
  inject?: (services: string[], callback: (context: DshSettingsRegistrationContext) => void) => unknown;
}

export function registerDshCollabSettings(context: DshCollabCordisContext, config: Partial<DshCordisHostConfig>): void {
  const gatewayHost = config.host ?? "127.0.0.1";
  context.inject?.(["settings"], (settingsContext) => {
    settingsContext.settings.register(DSH_COLLAB_SETTINGS_NAMESPACE, DSH_COLLAB_SETTINGS_SCHEMA, {
      base: {
        gateway: {
          gatewayHost,
          gatewayPort: config.port ?? 0,
          exposeMode: gatewayHost === "127.0.0.1" ? "loopback" : "network",
        },
        participantGatewayUrl: config.participantGatewayUrl ?? "",
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
  });
}

/**
 * Host entry point for a DSH Cordis row. Room/session fields are deliberately
 * opt-in: a profile that only installs the browser face cannot accidentally
 * create a room without a trusted local Agent session.
 */
export function apply(context?: DshCollabCordisContext, config?: Partial<DshCordisHostConfig>): void {
  if (!context || !config) return;
  registerDshCollabSettings(context, config);
  if (config.enabled === false) return;
  let localProxy: LocalNginxProxy | undefined;
  if (config.localProxy?.enabled === true && context.effect) {
    const targetPort = resolveDshPort(config.localProxy.targetPort ?? config.port);
    localProxy = createLocalNginxProxy({
      targetPort,
      collabTargetPort: config.localProxy.collabTargetPort,
      listenPort: resolveLocalProxyPort(targetPort, config.localProxy.listenPort),
      principalId: config.localProxy.principalId ?? config.hostId ?? "local-host",
      trustedProxyMarkerHeader: config.trustedProxyMarkerHeader,
      trustedPrincipalHeader: config.trustedPrincipalHeader,
    });
    void localProxy.start().catch((error: unknown) => console.warn("dsh-collab local nginx failed to start", error));
    const proxyForDispose = localProxy;
    context.effect(() => () => { void proxyForDispose.dispose(); }, "dsh-collab: local nginx");
  }
  if (typeof config.roomId !== "string" || typeof config.hostId !== "string" || typeof config.title !== "string" || typeof config.hostDisplayName !== "string") return;
  let mounted = mountDshCollabCordisHost(context, config as DshCordisHostConfig);
  let disposeCreated: (() => void) | undefined;
  if (!mounted && context.on && config.hostSessionId === undefined) {
    disposeCreated = context.on("agent/created", (payload) => {
      if (mounted) return;
      mounted = mountDshCollabCordisHost(context, { ...config, hostSessionId: payload.agent.id } as DshCordisHostConfig);
    });
  }
  if (!mounted && !disposeCreated) return;
  if (context.effect) {
    context.effect(() => () => {
      disposeCreated?.();
      if (mounted) void mounted.dispose();
    }, "dsh-collab: host routes");
  }
}

export default apply;
