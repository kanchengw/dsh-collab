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
import type { RoomSummaryLlmPort } from "./room-summary.js";
import type { DshCollabPersistedSettings } from "./settings.js";
import { bindDshNativeAgentContext, type DshNativeAgentContextAgent, type DshNativeAgentContextRegistry } from "./dsh-native-agent-context.js";
import { createDshRoomProjectSessionList, DshRoomProjectSessionObserver, type DshRoomProjectContextBinding, type RoomProjectSessionAssociation } from "./dsh-room-project-sessions.js";
import type { RoomProjectStore } from "./room-projects.js";

export interface DshCordisHostContext {
  agents: DshCordisAgentRegistry;
  sessions?: DshSessionStore;
  sessionQuery?: DshSessionQuery;
  webServer?: unknown;
  settings?: {
    register(namespace: string, schema: unknown, options: Record<string, unknown>): {
      get(): DshCollabPersistedSettings;
      update(patch: object): Promise<void>;
    };
  };
  llm?: RoomSummaryLlmPort;
  fs?: DshWorkspaceFileSystem;
  subprocess?: DshRepositorySubprocess;
  on?: {
    (event: "agent/created", listener: (payload: { agent: { id: string } }) => void): () => void;
    (event: "agent/disposed", listener: (payload: { agent: { id: string } }) => void): () => void;
    (event: "agent/status", listener: (payload: { agent: { id: string }; status: "idle" | "running" }) => void): () => void;
    (event: "agent/assistant-stream", listener: (payload: DshAssistantStreamPayload<object>) => void): () => void;
    (event: "session/event", listener: DshCordisSessionEventListener): () => void;
  };
}

export interface DshSessionStore {
  get(sessionId: string): { readonly header?: { readonly cwd?: string } } | undefined;
}

export interface DshSessionQuery {
  listSessions(): Promise<readonly {
    readonly header: { readonly id: string; readonly cwd?: string };
  }[]>;
}

/** Resolve a DSH Session cwd from a live Agent or the cold Session query. */
export async function resolveDshSessionWorkspacePath(input: {
  agents: DshCordisAgentRegistry;
  sessions?: DshSessionStore;
  sessionQuery?: DshSessionQuery;
}, sessionId: string): Promise<string | undefined> {
  const storedPath = input.sessions?.get(sessionId)?.header?.cwd;
  if (typeof storedPath === "string" && storedPath.trim() !== "") return storedPath;
  const livePath = input.agents.get(sessionId)?.session?.header?.cwd;
  if (typeof livePath === "string" && livePath.trim() !== "") return livePath;
  if (!input.sessionQuery) return undefined;
  const record = (await input.sessionQuery.listSessions()).find((candidate) => candidate.header.id === sessionId);
  return record?.header.cwd;
}

/** Connects live DSH Agent lifecycle to persisted Room Project associations. */
export function createDshRoomProjectSessionObserver(input: {
  context: DshCordisHostContext;
  projects: RoomProjectStore;
  onAssociation?: (association: RoomProjectSessionAssociation, binding: DshRoomProjectContextBinding) => void;
  onDisassociation?: (sessionId: string) => void;
}): DshRoomProjectSessionObserver {
  const nativeAgents = new Map<string, { source: NonNullable<ReturnType<DshCordisHostContext["agents"]["get"]>>; agent: DshNativeAgentContextAgent }>();
  const registry: DshNativeAgentContextRegistry = {
    get(sessionId) {
      const source = input.context.agents.get(sessionId);
      if (!source?.inject || !source.session) return undefined;
      const cached = nativeAgents.get(sessionId);
      if (cached?.source === source) return cached.agent;
      const agent: DshNativeAgentContextAgent = {
        id: sessionId,
        session: source.session,
        ...(source.status ? { status: source.status } : {}),
        ...(source.runMaintenance ? { runMaintenance: (task) => source.runMaintenance!(task) } : {}),
        inject(message) { source.inject?.(message as never); },
        ...(source.inbox ? { inbox: source.inbox } : {}),
      };
      nativeAgents.set(sessionId, { source, agent });
      return agent;
    },
  };
  const onLifecycle = (listener: () => void): (() => void) => {
    if (!input.context.on) return () => {};
    const disposers = [
      input.context.on("agent/created", listener as (payload: { agent: { id: string } }) => void),
      input.context.on("agent/disposed", listener as (payload: { agent: { id: string } }) => void),
      input.context.on("agent/status", listener as (payload: { agent: { id: string }; status: "idle" | "running" }) => void),
    ];
    return () => { for (const dispose of disposers) dispose(); };
  };
  const sessions = createDshRoomProjectSessionList({
    list: () => (input.context.agents.list?.() ?? []).filter((agent): agent is NonNullable<typeof agent> & { id: string } => typeof agent.id === "string"),
    subscribe: onLifecycle,
  });
  return new DshRoomProjectSessionObserver({
    projects: input.projects,
    sessions,
    ...(input.onAssociation ? { onAssociation: input.onAssociation } : {}),
    ...(input.onDisassociation ? { onDisassociation: input.onDisassociation } : {}),
    bind: (sessionId) => {
      if (!input.context.on) return undefined;
      const source = input.context.agents.get(sessionId);
      if (!source?.inject || !source.session || !source.runMaintenance || source.status !== "idle") return undefined;
      return bindDshNativeAgentContext({
        agents: registry,
        isSafeToInject: () => input.context.agents.get(sessionId)?.status === "idle",
        onSessionEvent: (listener) => input.context.on!("session/event", listener),
        sessionId,
      });
    },
  });
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
  workspacePath?: (sessionId: string) => Promise<string | undefined>;
  fs: DshWorkspaceFileSystem;
  subprocess: DshRepositorySubprocess;
  store: WorkspaceSnapshotStore;
}): WorkspaceSnapshotProvider {
  return {
    async capture(request) {
      const cwd = await input.workspacePath?.(request.hostSessionId) ?? input.sessions.workspacePath?.(request.hostSessionId);
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
      const cwd = await input.workspacePath?.(request.snapshot.hostSessionId) ?? input.sessions.workspacePath?.(request.snapshot.hostSessionId);
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
      workspacePath: (sessionId) => resolveDshSessionWorkspacePath({ agents: context.agents, sessions: context.sessions, sessionQuery: context.sessionQuery }, sessionId),
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
