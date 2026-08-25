export * from "./approvals.js";
export * from "./audit.js";
export * from "./room-client.js";
export * from "./gateway.js";
export * from "./dsh-host.js";
export * from "./dsh-cordis-agent.js";
export * from "./dsh-cordis-host.js";
export * from "./dsh-client.js";
export * from "./dsh-browser-client.js";
export * from "./endpoint-policy.js";
export * from "./host-runtime.js";
export * from "./http.js";
export * from "./manifest.js";
export * from "./invitation.js";
export * from "./participant.js";
export * from "./persistence.js";
export * from "./resume-credentials.js";
export * from "./role.js";
export * from "./runtime.js";
export * from "./settings.js";
export * from "./ui.js";

import { mountDshCollabCordisHost, type DshCordisHostConfig, type DshCordisHostContext } from "./dsh-cordis-host.js";
import { defaultCollabSettings, DSH_COLLAB_SETTINGS_NAMESPACE, DSH_COLLAB_SETTINGS_SCHEMA, validateDshCollabPersistedSettings, type DshCollabPersistedSettings } from "./settings.js";

interface DshSettingsRegistrationContext {
  settings: {
    register(namespace: string, schema: unknown, options: Record<string, unknown>): { get(): DshCollabPersistedSettings };
  };
}

export interface DshCollabCordisContext extends DshCordisHostContext {
  effect?: (factory: () => (() => void | Promise<void>) | void, name?: string) => () => void | Promise<void>;
  inject?: (services: string[], callback: (context: DshSettingsRegistrationContext) => void) => unknown;
}

export function registerDshCollabSettings(
  context: DshCollabCordisContext,
  config: Partial<DshCordisHostConfig>,
  onResolved?: (settings: DshCollabPersistedSettings) => void,
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
    onResolved?.(scope.get());
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

function mountConfiguredHost(context: DshCollabCordisContext, config: Partial<DshCordisHostConfig>): void {
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
    context.effect(() => async () => {
      disposeCreated?.();
      if (mounted) await mounted.dispose();
    }, "dsh-collab: Host Gateway");
  }
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
  if (context.inject) registerDshCollabSettings(context, config, (settings) => mountConfiguredHost(context, applyPersistedSettings(config, settings)));
  else mountConfiguredHost(context, config);
}

export default apply;
