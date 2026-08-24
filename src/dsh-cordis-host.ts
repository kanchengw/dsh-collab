import { createDshCordisSessionService, type DshCordisAgentRegistry } from "./dsh-cordis-agent.js";
import { registerDshCollabHost, type DshSessionService } from "./dsh-host.js";
import { createDshCollabHostRuntime, type DshCollabHostRuntime, type DshCollabHostRuntimeOptions } from "./host-runtime.js";
import type { CollabWebServer } from "./webserver.js";

export interface DshCordisHostContext {
  webServer: CollabWebServer;
  agents: DshCordisAgentRegistry;
}

export type DshCordisHostConfig = Omit<DshCollabHostRuntimeOptions, "sessions"> & {
  enabled?: boolean;
  principalFromHeaders?: (headers: Record<string, string | undefined>) => string | undefined;
};

export interface MountedDshCollabHost {
  runtime: DshCollabHostRuntime;
  dispose(): Promise<void>;
}

/** Mount one collab Gateway into the real Cordis WebServer and Agent registry. */
export function mountDshCollabCordisHost(context: DshCordisHostContext, config: DshCordisHostConfig): MountedDshCollabHost | undefined {
  if (config.enabled === false) return undefined;
  const sessions: DshSessionService = createDshCordisSessionService({ agents: context.agents });
  const runtime = createDshCollabHostRuntime({ ...config, sessions });
  const disposeRoutes = registerDshCollabHost({
    webServer: context.webServer,
    http: {
      gateway: runtime.gateway,
      authenticate: ({ headers }) => ({ principalId: config.principalFromHeaders?.(headers) ?? headers["x-dsh-principal-id"] }),
    },
    upgrade: runtime.upgrade,
  });
  return {
    runtime,
    async dispose(): Promise<void> {
      disposeRoutes();
      await runtime.dispose();
    },
  };
}
