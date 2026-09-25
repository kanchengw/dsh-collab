import { realpath } from "node:fs/promises";
import {
  RoomProjectStore,
  type RegisterRoomProjectInput,
  type RoomProject,
  type RoomProjectRegistrationOptions,
  type RoomProjectSnapshot,
} from "./room-projects.js";

export interface DshRoomProjectWorkspaceService {
  create(path: string, title?: string): Promise<{ workspaceId: string }>;
}

export interface RoomProjectPersistence {
  save(snapshot: RoomProjectSnapshot): Promise<void>;
}

export interface DshRoomProjectRegistrationInput extends RegisterRoomProjectInput {
  nativeWorkspaceTitle?: string;
}

export class DshRoomProjectRegistrar {
  private queue = Promise.resolve();

  constructor(private readonly input: {
    store: RoomProjectStore;
    persistence: RoomProjectPersistence;
    workspaces: DshRoomProjectWorkspaceService;
  }) {}

  register(input: DshRoomProjectRegistrationInput, options: RoomProjectRegistrationOptions = {}): Promise<RoomProject> {
    const operation = this.queue.then(() => this.registerNow(input, options));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  recordHostPrimarySession(input: { roomId: string; sessionId: string }): Promise<RoomProject> {
    const operation = this.queue.then(() => this.recordHostPrimarySessionNow(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async registerNow(input: DshRoomProjectRegistrationInput, options: RoomProjectRegistrationOptions): Promise<RoomProject> {
    const canonicalInput = { ...input, workspacePath: await realpath(input.workspacePath) };
    // Keep the live mapping untouched until both DSH and durable storage succeed.
    const staged = RoomProjectStore.fromSnapshot(this.input.store.snapshot());
    let project = staged.register(canonicalInput, options);
    const wasRegistered = project.nativeWorkspaceId !== undefined;
    if (!wasRegistered) {
      const nativeWorkspaceTitle = input.nativeWorkspaceTitle?.trim() || project.roomTitle;
      const workspace = await this.input.workspaces.create(project.workspacePath, nativeWorkspaceTitle);
      project = staged.setNativeWorkspaceId({ roomId: project.roomId, nativeWorkspaceId: workspace.workspaceId });
    }
    await this.input.persistence.save(staged.snapshot());

    const committed = this.input.store.register(canonicalInput, options);
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
