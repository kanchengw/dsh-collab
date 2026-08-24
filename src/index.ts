export * from "./approvals.js";
export * from "./audit.js";
export * from "./client.js";
export * from "./gateway.js";
export * from "./dsh-host.js";
export * from "./dsh-cordis-agent.js";
export * from "./dsh-cordis-host.js";
export * from "./host-runtime.js";
export * from "./http.js";
export * from "./manifest.js";
export * from "./participant.js";
export * from "./role.js";
export * from "./runtime.js";
export * from "./settings.js";
export * from "./ui.js";
export * from "./webserver.js";

import { mountDshCollabCordisHost, type DshCordisHostConfig, type DshCordisHostContext } from "./dsh-cordis-host.js";

export interface DshCollabCordisContext extends DshCordisHostContext {
  effect?: (factory: () => (() => void) | void, name?: string) => () => void;
}

/**
 * Host entry point for a DSH Cordis row. Room/session fields are deliberately
 * opt-in: a profile that only installs the browser face cannot accidentally
 * create a room without a trusted local Agent session.
 */
export function apply(context?: DshCollabCordisContext, config?: Partial<DshCordisHostConfig>): void {
  if (!context || !config || config.enabled === false) return;
  if (typeof config.roomId !== "string" || typeof config.hostId !== "string" || typeof config.hostSessionId !== "string" || typeof config.title !== "string" || typeof config.hostDisplayName !== "string") return;
  const mounted = mountDshCollabCordisHost(context, config as DshCordisHostConfig);
  if (!mounted) return;
  if (context.effect) {
    context.effect(() => () => { void mounted.dispose(); }, "dsh-collab: host routes");
  }
}

export default apply;
