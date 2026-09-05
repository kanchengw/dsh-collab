import { createDshCordisSessionService, type DshCordisAgentRegistry, type DshCordisSessionEventListener } from "./dsh-cordis-agent.js";
import type { DshAssistantStreamPayload } from "./dsh-assistant-stream.js";
import type { DshSessionService } from "./dsh-host.js";
import { createDshCollabHostRuntime, type DshCollabHostRuntime, type DshCollabHostRuntimeOptions } from "./host-runtime.js";
import { HostSnapshotFile, resolveDefaultCollabChangeSetDir, resolveDefaultCollabIntegrationJournalDir, resolveDefaultCollabSnapshotDir, resolveDefaultCollabStateFile } from "./persistence.js";
import { createDshRepositoryCommandPort, type DshRepositorySubprocess } from "./repository-inspector.js";
import { captureReviewDiffs } from "./review-diffs.js";
import { createDshWorkspaceFilePort, WorkspaceSnapshotCapture, type DshWorkspaceFileSystem } from "./workspace-snapshot.js";
import { WorkspaceSnapshotStore } from "./workspace-snapshot-store.js";
import type { WorkspaceSnapshotProvider } from "./workspace-service.js";
import { supportsDshCanonicalWorkspace } from "./canonical-workspace.js";

export interface DshCordisHostContext {
  agents: DshCordisAgentRegistry;
  fs?: DshWorkspaceFileSystem;
  subprocess?: DshRepositorySubprocess;
  on?: {
    (event: "agent/created", listener: (payload: { agent: { id: string } }) => void): () => void;
    (event: "agent/assistant-stream", listener: (payload: DshAssistantStreamPayload<object>) => void): () => void;
    (event: "session/event", listener: DshCordisSessionEventListener): () => void;
  };
}

export type DshCordisHostConfig = Omit<DshCollabHostRuntimeOptions, "sessions" | "hostSessionId" | "workspaceSnapshots" | "changeSetSubprocess" | "canonicalFiles" | "integrationJournalRoot"> & {
  enabled?: boolean;
  hostSessionId?: string;
  stateFile?: string | false;
  sideTaskFile?: string | false;
  integrationJournalRoot?: string | false;
};

export interface MountedDshCollabHost {
  runtime: DshCollabHostRuntime;
  workspaceSnapshots?: WorkspaceSnapshotProvider;
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
    readFile: (snapshotId, path) => input.store.readFile(snapshotId, path),
    readChunk: (snapshotId, path, offset, length) => input.store.readChunk(snapshotId, path, offset, length),
    async captureReviewDiffs(request) {
      const cwd = input.sessions.workspacePath?.(request.snapshot.hostSessionId);
      if (!cwd) throw new Error("Host session does not expose a workspace path");
      return await captureReviewDiffs({
        ...request,
        commands: createDshRepositoryCommandPort({ subprocess: input.subprocess, cwd }),
        readSnapshotFile: (path) => input.store.readFile(request.snapshot.snapshotId, path),
      });
    },
  };
}

/** Mount one collab Gateway into the real Cordis WebServer and Agent registry. */
export function mountDshCollabCordisHost(context: DshCordisHostContext, config: DshCordisHostConfig): MountedDshCollabHost | undefined {
  if (config.enabled === false) return undefined;
  const { integrationJournalRoot, ...runtimeConfig } = config;
  const sessions: DshSessionService = createDshCordisSessionService({
    agents: context.agents,
    ...(context.on ? { onSessionEvent: (listener: DshCordisSessionEventListener) => context.on!("session/event", listener) } : {}),
    ...(context.on ? { onAssistantStream: (listener: (payload: DshAssistantStreamPayload<object>) => void) => context.on!("agent/assistant-stream", listener) } : {}),
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
  let runtime: DshCollabHostRuntime;
  const commitCriticalState = persistence ? () => persistence.save(runtime.snapshot()) : undefined;
  runtime = createDshCollabHostRuntime({
    ...runtimeConfig,
    sessions,
    snapshot,
    workspaceSnapshots,
    ...(context.fs && supportsDshCanonicalWorkspace(context.fs) ? { canonicalFiles: context.fs } : {}),
    ...(integrationJournalRoot === false || config.stateFile === false
      ? {}
      : { integrationJournalRoot: integrationJournalRoot ?? resolveDefaultCollabIntegrationJournalDir() }),
    ...(workspaceSnapshots && context.subprocess ? {
      changeSetRoot: config.changeSetRoot ?? resolveDefaultCollabChangeSetDir(),
      changeSetSubprocess: context.subprocess,
    } : {}),
    commitCriticalState,
  });
  const ready = (async () => {
    await runtime.recoverPendingIntegrations();
    await runtime.commitCriticalState();
    return await runtime.http.listen();
  })();
  void ready.catch((error: unknown) => console.warn("dsh-collab Gateway failed to listen", error));
  return {
    runtime,
    ...(workspaceSnapshots ? { workspaceSnapshots } : {}),
    ready,
    async dispose(): Promise<void> {
      await ready.catch(() => undefined);
      try {
        await runtime.commitCriticalState();
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
