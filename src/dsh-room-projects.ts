import {
  RoomProjectStore,
  type RegisterRoomProjectInput,
  type RoomProject,
  type RoomProjectSnapshot,
} from "./room-projects.js";

export interface DshRoomProjectWorkspaceService {
  create(input: { path: string }): Promise<{ workspaceId: string }>;
  rename(workspaceId: string, title: string): Promise<unknown>;
}

export interface RoomProjectPersistence {
  save(snapshot: RoomProjectSnapshot): Promise<void>;
}

export class DshRoomProjectRegistrar {
  private queue = Promise.resolve();

  constructor(private readonly input: {
    store: RoomProjectStore;
    persistence: RoomProjectPersistence;
    workspaces: DshRoomProjectWorkspaceService;
  }) {}

  register(input: RegisterRoomProjectInput): Promise<RoomProject> {
    const operation = this.queue.then(() => this.registerNow(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  recordHostPrimarySession(input: { roomId: string; sessionId: string }): Promise<RoomProject> {
    const operation = this.queue.then(() => this.recordHostPrimarySessionNow(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async registerNow(input: RegisterRoomProjectInput): Promise<RoomProject> {
    // Keep the live mapping untouched until both DSH and durable storage succeed.
    const staged = RoomProjectStore.fromSnapshot(this.input.store.snapshot());
    let project = staged.register(input);
    const wasRegistered = project.nativeWorkspaceId !== undefined;
    if (!wasRegistered) {
      const workspace = await this.input.workspaces.create({ path: project.workspacePath });
      await this.input.workspaces.rename(workspace.workspaceId, project.roomTitle);
      project = staged.setNativeWorkspaceId({ roomId: project.roomId, nativeWorkspaceId: workspace.workspaceId });
    }
    await this.input.persistence.save(staged.snapshot());

    const committed = this.input.store.register(input);
    if (wasRegistered) return committed;
    if (!project.nativeWorkspaceId) throw new Error("Native Workspace registration is missing");
    return this.input.store.setNativeWorkspaceId({ roomId: committed.roomId, nativeWorkspaceId: project.nativeWorkspaceId });
  }

  private async recordHostPrimarySessionNow(input: { roomId: string; sessionId: string }): Promise<RoomProject> {
    const staged = RoomProjectStore.fromSnapshot(this.input.store.snapshot());
    staged.setHostPrimarySessionId(input);
    await this.input.persistence.save(staged.snapshot());
    return this.input.store.setHostPrimarySessionId(input);
  }
}
