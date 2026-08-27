import { createDshCordisSessionService, type DshCordisAgentRegistry, type DshCordisSessionEventListener } from "./dsh-cordis-agent.js";
import type { DshSessionService } from "./dsh-host.js";
import { createDshCollabHostRuntime, type DshCollabHostRuntime, type DshCollabHostRuntimeOptions } from "./host-runtime.js";
import { HostSnapshotFile, resolveDefaultCollabStateFile } from "./persistence.js";

export interface DshCordisHostContext {
  agents: DshCordisAgentRegistry;
  on?: {
    (event: "agent/created", listener: (payload: { agent: { id: string } }) => void): () => void;
    (event: "session/event", listener: DshCordisSessionEventListener): () => void;
  };
}

export type DshCordisHostConfig = Omit<DshCollabHostRuntimeOptions, "sessions" | "hostSessionId"> & {
  enabled?: boolean;
  hostSessionId?: string;
  stateFile?: string | false;
};

export interface MountedDshCollabHost {
  runtime: DshCollabHostRuntime;
  ready: Promise<number>;
  dispose(): Promise<void>;
}

/** Mount one collab Gateway into the real Cordis WebServer and Agent registry. */
export function mountDshCollabCordisHost(context: DshCordisHostContext, config: DshCordisHostConfig): MountedDshCollabHost | undefined {
  if (config.enabled === false) return undefined;
  const sessions: DshSessionService = createDshCordisSessionService({
    agents: context.agents,
    ...(context.on ? { onSessionEvent: (listener: DshCordisSessionEventListener) => context.on!("session/event", listener) } : {}),
  });
  const persistence = config.stateFile === false ? undefined : new HostSnapshotFile(config.stateFile ?? resolveDefaultCollabStateFile());
  const snapshot = persistence?.loadSync();
  const runtime = createDshCollabHostRuntime({ ...config, sessions, snapshot });
  const save = (): void => {
    void persistence?.save(runtime.snapshot()).catch((error: unknown) => console.warn("dsh-collab state save failed", error));
  };
  const unsubscribeLedger = persistence ? runtime.ledger.subscribe(save) : undefined;
  const unsubscribeRooms = persistence ? runtime.rooms.subscribe(save) : undefined;
  const ready = runtime.http.listen();
  void ready.catch((error: unknown) => console.warn("dsh-collab Gateway failed to listen", error));
  void persistence?.save(runtime.snapshot()).catch((error: unknown) => console.warn("dsh-collab state save failed", error));
  return {
    runtime,
    ready,
    async dispose(): Promise<void> {
      await ready.catch(() => undefined);
      unsubscribeLedger?.();
      unsubscribeRooms?.();
      await persistence?.save(runtime.snapshot());
      try {
        await runtime.dispose();
      } finally {
        sessions.dispose?.();
      }
    },
  };
}
