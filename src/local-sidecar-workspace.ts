import { createHash, randomUUID } from "node:crypto";
import { CollaborationWorkspaceClient } from "./collaboration-client.js";
import { gatewayHttpUrl } from "./endpoint-policy.js";
import type { LocalSidecarWorkspacePort } from "./local-sidecar.js";
import type { ParticipantGatewayTransport } from "./participant.js";
import { resolveDefaultCollabWorkspaceDir } from "./persistence.js";
import { materializeSnapshotFromProvider, SnapshotWorkspaceMaterializer } from "./snapshot-workspace.js";
import type { WorkspaceSnapshotProvider } from "./workspace-service.js";

export interface LocalHostWorkspaceAccess {
  provider: WorkspaceSnapshotProvider;
  hostSessionId: string;
  roomEventSeq: number;
}

type NodeFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

function remoteTransport(endpoint: string, fetcher: NodeFetch): ParticipantGatewayTransport {
  const base = gatewayHttpUrl(endpoint).replace(/\/$/, "");
  return {
    async request(input) {
      const response = await fetcher(`${base}${input.path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${input.token}`,
          ...(input.capabilities?.length ? { "x-dsh-collab-capabilities": input.capabilities.join(",") } : {}),
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      const envelope = await response.json() as { data?: unknown };
      return { status: response.status, body: envelope?.data };
    },
  };
}

export class DshLocalSidecarWorkspace implements LocalSidecarWorkspacePort {
  private readonly materializer: SnapshotWorkspaceMaterializer;
  private readonly fetcher: NodeFetch;

  constructor(private readonly options: {
    local(roomId: string): LocalHostWorkspaceAccess | undefined;
    root?: string;
    fetch?: NodeFetch;
  }) {
    this.materializer = new SnapshotWorkspaceMaterializer({ root: options.root ?? resolveDefaultCollabWorkspaceDir() });
    this.fetcher = options.fetch ?? (globalThis.fetch as unknown as NodeFetch);
    if (!this.fetcher) throw new Error("fetch is unavailable");
  }

  async prepare(input: Parameters<LocalSidecarWorkspacePort["prepare"]>[0]) {
    if (input.remote) {
      if (input.remote.roomToken.trim() === "") throw new Error("Participant room credential is unavailable");
      const client = new CollaborationWorkspaceClient({
        transport: remoteTransport(input.remote.gatewayEndpoint, this.fetcher),
        materializer: this.materializer,
      });
      return input.snapshotId
        ? await client.downloadSnapshot({ roomId: input.roomId, token: input.remote.roomToken, snapshotId: input.snapshotId })
        : await client.downloadLatest({ roomId: input.roomId, token: input.remote.roomToken });
    }

    const local = this.options.local(input.roomId);
    if (!local) throw new Error("Owned room workspace is unavailable");
    let snapshotId = input.snapshotId;
    if (!snapshotId) {
      snapshotId = createHash("sha256").update(`${input.roomId}\0${randomUUID()}`).digest("hex");
      await local.provider.capture({
        roomId: input.roomId,
        hostSessionId: local.hostSessionId,
        roomEventSeq: local.roomEventSeq,
        snapshotId,
      });
    }
    const workspace = await materializeSnapshotFromProvider({ snapshotId, provider: local.provider, materializer: this.materializer });
    if (workspace.snapshot.roomId !== input.roomId || workspace.snapshot.hostSessionId !== local.hostSessionId) {
      await workspace.dispose();
      throw new Error("Workspace Snapshot does not belong to requested room");
    }
    return workspace;
  }
}
