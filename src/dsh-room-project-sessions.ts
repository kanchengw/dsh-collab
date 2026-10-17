import type { DshNativeAgentContextBinding } from "./dsh-native-agent-context.js";
import { CollabError } from "./errors.js";
import type { RoomProject } from "./room-projects.js";
import { RoomProjectStore } from "./room-projects.js";

export interface DshRoomProjectSessionListSnapshot {
  ids: readonly string[];
  byId: Readonly<Record<string, { id: string; cwd?: string }>>;
}

export interface DshRoomProjectSessionList {
  getSnapshot(): DshRoomProjectSessionListSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface DshRoomProjectSessionAgent {
  readonly id: string;
  readonly session?: { readonly header?: { readonly cwd?: string } };
}

/** Projects the live DSH Agent registry into the Session-list seam used by the observer. */
export function createDshRoomProjectSessionList(input: {
  list(): readonly DshRoomProjectSessionAgent[];
  subscribe(listener: () => void): () => void;
}): DshRoomProjectSessionList {
  return {
    getSnapshot() {
      const agents = input.list();
      return {
        ids: agents.map((agent) => agent.id),
        byId: Object.fromEntries(agents.map((agent) => [agent.id, {
          id: agent.id,
          ...(agent.session?.header?.cwd ? { cwd: agent.session.header.cwd } : {}),
        }])),
      };
    },
    subscribe: input.subscribe,
  };
}

export type DshRoomProjectContextBinding = Pick<DshNativeAgentContextBinding, "deliver">
  & Partial<Pick<DshNativeAgentContextBinding, "isSafeToInject">>
  & Partial<Pick<DshNativeAgentContextBinding, "dispose">>;

export interface RoomProjectSessionAssociation {
  sessionId: string;
  roomId: string;
  memberId: string;
  workspacePath: string;
  initialContextDelivered: boolean;
}

function deliveryId(project: RoomProject, sessionId: string): string {
  return `room-project-context:${project.roomId}:${project.memberId}:${sessionId}`;
}

/** The bounded identity packet sent before structured Room Context arrives in CRP-U08. */
export function formatInitialRoomProjectContext(project: Pick<RoomProject, "roomId" | "memberId" | "roomTitle" | "workspacePath">): string {
  return JSON.stringify({
    kind: "dsh-collab.room-project-context",
    roomId: project.roomId,
    memberId: project.memberId,
    roomTitle: project.roomTitle,
    workspacePath: project.workspacePath,
  });
}

function sameAssociation(association: RoomProjectSessionAssociation, project: RoomProject): boolean {
  return association.roomId === project.roomId
    && association.memberId === project.memberId
    && association.workspacePath === project.workspacePath;
}

/** Resolves a local Room Project only when a native Session reports its exact workspace path. */
export function roomProjectForCwd(projects: RoomProjectStore, cwd: string | undefined): RoomProject | undefined {
  if (!cwd) return undefined;
  try {
    return projects.getByWorkspacePath(cwd);
  } catch {
    return undefined;
  }
}

/** Associates only native Sessions whose cwd exactly matches a local Room Workspace. */
export class DshRoomProjectSessionObserver {
  private readonly associations = new Map<string, RoomProjectSessionAssociation>();
  private readonly bindings = new Map<string, DshRoomProjectContextBinding>();
  private unsubscribe?: () => void;

  constructor(private readonly input: {
    projects: RoomProjectStore;
    sessions: DshRoomProjectSessionList;
    bind(sessionId: string): DshRoomProjectContextBinding | undefined;
    onAssociation?: (association: RoomProjectSessionAssociation, binding: DshRoomProjectContextBinding) => void;
    onDisassociation?: (sessionId: string) => void;
  }) {}

  start(): void {
    if (this.unsubscribe) return;
    this.reconcile();
    this.unsubscribe = this.input.sessions.subscribe(() => { this.reconcile(); });
  }

  reconcile(): void {
    const snapshot = this.input.sessions.getSnapshot();
    const seen = new Set<string>();
    for (const sessionId of snapshot.ids) {
      seen.add(sessionId);
      const project = this.projectFor(snapshot.byId[sessionId]?.cwd);
      if (!project) {
        this.remove(sessionId);
        continue;
      }
      let association = this.associations.get(sessionId);
      if (!association || !sameAssociation(association, project)) {
        this.remove(sessionId);
        association = {
          sessionId,
          roomId: project.roomId,
          memberId: project.memberId,
          workspacePath: project.workspacePath,
          initialContextDelivered: false,
        };
        this.associations.set(sessionId, association);
      }
      if (association.initialContextDelivered) continue;
      const binding = this.bindings.get(sessionId) ?? this.input.bind(sessionId);
      if (!binding) continue;
      this.bindings.set(sessionId, binding);
      this.input.onAssociation?.(structuredClone(association), binding);
      if (binding.isSafeToInject && !binding.isSafeToInject()) continue;
      try {
        binding.deliver({
          deliveryId: deliveryId(project, sessionId),
          text: formatInitialRoomProjectContext(project),
        });
      } catch (error) {
        if (error instanceof CollabError && error.code === "REQUEST_CONFLICT") continue;
        throw error;
      }
      association.initialContextDelivered = true;
    }
    for (const sessionId of this.associations.keys()) {
      if (!seen.has(sessionId)) this.remove(sessionId);
    }
  }

  get(sessionId: string): RoomProjectSessionAssociation | undefined {
    const association = this.associations.get(sessionId);
    return association ? structuredClone(association) : undefined;
  }

  list(): RoomProjectSessionAssociation[] {
    return [...this.associations.values()].map((association) => structuredClone(association));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const sessionId of [...this.associations.keys()]) this.remove(sessionId);
  }

  private projectFor(cwd: string | undefined): RoomProject | undefined {
    return roomProjectForCwd(this.input.projects, cwd);
  }

  private remove(sessionId: string): void {
    if (this.associations.has(sessionId)) this.input.onDisassociation?.(sessionId);
    this.associations.delete(sessionId);
    const binding = this.bindings.get(sessionId);
    this.bindings.delete(sessionId);
    binding?.dispose?.();
  }
}
