import { createDshCordisSessionService, type DshCordisAgentRegistry, type DshCordisSessionEventListener } from "./dsh-cordis-agent.js";
import type { DshSessionService } from "./dsh-host.js";
import { createDshCollabHostRuntime, type DshCollabHostRuntime, type DshCollabHostRuntimeOptions } from "./host-runtime.js";
import { HostSnapshotFile, resolveDefaultCollabSnapshotDir, resolveDefaultCollabStateFile } from "./persistence.js";
import { createDshRepositoryCommandPort, type DshRepositorySubprocess } from "./repository-inspector.js";
import { createDshWorkspaceFilePort, WorkspaceSnapshotCapture, type DshWorkspaceFileSystem } from "./workspace-snapshot.js";
import { WorkspaceSnapshotStore } from "./workspace-snapshot-store.js";
import type { WorkspaceSnapshotProvider } from "./workspace-service.js";

export interface DshCordisHostContext {
  agents: DshCordisAgentRegistry;
  fs?: DshWorkspaceFileSystem;
  subprocess?: DshRepositorySubprocess;
  on?: {
    (event: "agent/created", listener: (payload: { agent: { id: string } }) => void): () => void;
    (event: "session/event", listener: DshCordisSessionEventListener): () => void;
  };
}

export type DshCordisHostConfig = Omit<DshCollabHostRuntimeOptions, "sessions" | "hostSessionId" | "workspaceSnapshots"> & {
  enabled?: boolean;
  hostSessionId?: string;
  stateFile?: string | false;
};

export interface MountedDshCollabHost {
  runtime: DshCollabHostRuntime;
  ready: Promise<number>;
  dispose(): Promise<void>;
}

export function createDshWorkspaceSnapshotProvider(input: {
  sessions: DshSessionService;
  fs: DshWorkspaceFileSystem;
  subprocess: DshRepositorySubprocess;
  store: WorkspaceSnapshotStore;
}): WorkspaceSnapshotProvider {
  return {
    async capture(request) {
      const cwd = input.sessions.workspacePath?.(request.hostSessionId);
      if (!cwd) throw new Error("Host session does not expose a workspace path");
      return await new WorkspaceSnapshotCapture({
        commands: createDshRepositoryCommandPort({ subprocess: input.subprocess, cwd }),
        files: createDshWorkspaceFilePort({ fs: input.fs, cwd }),
        store: input.store,
      }).capture(request);
    },
    load: (snapshotId) => input.store.load(snapshotId),
    readChunk: (snapshotId, path, offset, length) => input.store.readChunk(snapshotId, path, offset, length),
  };
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
  const workspaceSnapshots = context.fs && context.subprocess
    ? createDshWorkspaceSnapshotProvider({
        sessions,
        fs: context.fs,
        subprocess: context.subprocess,
        store: new WorkspaceSnapshotStore(resolveDefaultCollabSnapshotDir()),
      })
    : undefined;
  const runtime = createDshCollabHostRuntime({ ...config, sessions, snapshot, workspaceSnapshots });
  const save = (): void => {
    void persistence?.save(runtime.snapshot()).catch((error: unknown) => console.warn("dsh-collab state save failed", error));
  };
  const unsubscribeLedger = persistence ? runtime.ledger.subscribe(save) : undefined;
  const unsubscribeRooms = persistence ? runtime.rooms.subscribe(save) : undefined;
  const unsubscribeReviewPoints = persistence ? runtime.reviewPoints.subscribe(save) : undefined;
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
      unsubscribeReviewPoints?.();
      try {
        await persistence?.save(runtime.snapshot());
      } finally {
        try {
          await runtime.dispose();
        } finally {
          sessions.dispose?.();
        }
      }
    },
  };
}
