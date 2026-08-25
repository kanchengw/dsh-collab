import { createDshCordisSessionService, type DshCordisAgentRegistry } from "./dsh-cordis-agent.js";
import type { DshSessionService } from "./dsh-host.js";
import { createDshCollabHostRuntime, type DshCollabHostRuntime, type DshCollabHostRuntimeOptions } from "./host-runtime.js";

export interface DshCordisHostContext {
  agents: DshCordisAgentRegistry;
  on?: (event: "agent/created", listener: (payload: { agent: { id: string } }) => void) => () => void;
}

export type DshCordisHostConfig = Omit<DshCollabHostRuntimeOptions, "sessions" | "hostSessionId"> & {
  enabled?: boolean;
  hostSessionId?: string;
  participantGatewayUrl?: string;
};

export interface MountedDshCollabHost {
  runtime: DshCollabHostRuntime;
  ready: Promise<number>;
  dispose(): Promise<void>;
}

/** Mount one collab Gateway into the real Cordis WebServer and Agent registry. */
export function mountDshCollabCordisHost(context: DshCordisHostContext, config: DshCordisHostConfig): MountedDshCollabHost | undefined {
  if (config.enabled === false) return undefined;
  const hostSessionId = config.hostSessionId ?? ((context.agents as DshCordisAgentRegistry & { list?: () => Array<{ id: string }> }).list?.()[0]?.id);
  if (!hostSessionId) return undefined;
  const sessions: DshSessionService = createDshCordisSessionService({ agents: context.agents });
  const runtime = createDshCollabHostRuntime({ ...config, hostSessionId, sessions });
  const ready = runtime.http.listen();
  void ready.catch((error: unknown) => console.warn("dsh-collab Gateway failed to listen", error));
  return {
    runtime,
    ready,
    async dispose(): Promise<void> {
      await ready.catch(() => undefined);
      await runtime.dispose();
    },
  };
}
