export const SIDECAR_REVIEW_CAPABILITY = "sidecar-review.v1" as const;
export const WORKSPACE_VERSION_CAPABILITY = "workspace-version.v1" as const;
export const CHANGE_SET_CAPABILITY = "change-set.v1" as const;

export type CollaborationCapability = typeof SIDECAR_REVIEW_CAPABILITY | typeof WORKSPACE_VERSION_CAPABILITY | typeof CHANGE_SET_CAPABILITY;

export type WorkspaceSharingState =
  | { roomId: string; enabled: false; revision: number }
  | { roomId: string; enabled: true; enabledBy: string; enabledAt: number; revision: number };

export interface WorkspaceSnapshotFile {
  path: string;
  contentHash: string;
  size: number;
  source: "tracked" | "untracked";
}

export interface WorkspaceSnapshotPackage {
  snapshotId: string;
  roomId: string;
  hostSessionId: string;
  roomEventSeq: number;
  headOid?: string;
  manifestHash: string;
  files: WorkspaceSnapshotFile[];
  createdAt: number;
}

export interface WorkspaceSnapshotChunk {
  snapshotId: string;
  fileIndex: number;
  offset: number;
  byteLength: number;
  chunkHash: string;
  data: string;
  eof: boolean;
}

export type ReviewLifecycle = "open" | "changes-requested" | "approved" | "closed";
export type ReviewFreshness = "current" | "stale";

export interface ReviewProgress {
  roomEventDelta: number;
  workspaceChangedFileCount: number;
}

export interface ReviewPointFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  baseBlobOid?: string;
  snapshotContentHash?: string;
  additions: number;
  deletions: number;
}

export interface ReviewPointCreateInput {
  title: string;
  focus?: string;
  files: Array<Pick<ReviewPointFile, "path" | "previousPath" | "status" | "additions" | "deletions">>;
}

export interface ReviewPoint {
  reviewPointId: string;
  roomId: string;
  title: string;
  focus?: string;
  createdBy: string;
  reviewerIds: string[];
  lifecycle: ReviewLifecycle;
  roomEventSeq: number;
  mainAgentSessionId: string;
  workspaceSnapshotId: string;
  headOid: string;
  files: ReviewPointFile[];
  createdAt: number;
}

export interface ReviewPointProjection {
  reviewPoint: ReviewPoint;
  freshness: ReviewFreshness;
  progress: ReviewProgress;
}

export interface ReviewPointPage {
  reviewPoints: ReviewPointProjection[];
  nextCursor?: string;
}

export type ReviewPointDiff =
  | { path: string; kind: "text"; oldText: string | null; newText: string | null }
  | { path: string; kind: "binary" }
  | { path: string; kind: "unavailable" };

export type ReviewFindingLocation =
  | { kind: "general" }
  | { kind: "file"; path: string }
  | { kind: "line"; path: string; line: number };

export interface ReviewFinding {
  findingId: string;
  roomId: string;
  reviewPointId: string;
  authorId: string;
  severity: "critical" | "high" | "medium" | "low" | "note";
  location: ReviewFindingLocation;
  body: string;
  state: "open" | "accepted" | "dismissed" | "resolved";
  createdAt: number;
  decidedBy?: string;
  decidedAt?: number;
}

export interface ReviewFindingCreateInput {
  severity: ReviewFinding["severity"];
  location: ReviewFindingLocation;
  body: string;
}

export interface ReviewFindingPage {
  findings: ReviewFinding[];
  nextCursor?: string;
}

export interface ReviewPublication {
  publicationId: string;
  roomId: string;
  reviewPointId: string;
  taskId: string;
  workspaceSnapshotId: string;
  publishedBy: string;
  summary: string;
  findingIds: string[];
  state: "published" | "accepted";
  createdAt: number;
  acceptedBy?: string;
  acceptedAt?: number;
  integrationRequestId?: string;
}

export interface ReviewPublicationPage {
  publications: ReviewPublication[];
}

export interface ReviewPublicationCreateInput {
  taskId: string;
  workspaceSnapshotId: string;
  summary: string;
  findings: ReviewFindingCreateInput[];
}

export interface AcceptedReviewPublication {
  publication: ReviewPublication;
  findings: ReviewFinding[];
}

export type SideTaskType = "explain" | "review";
export type SideTaskState =
  | { status: "queued" }
  | { status: "running" }
  | { status: "completed" }
  | { status: "failed"; error: string }
  | { status: "cancelled" };
export type SideTaskPublication =
  | { status: "private" }
  | { status: "published"; publicationId: string; publishedAt: number };

export interface SideTask {
  taskId: string;
  roomId: string;
  type: SideTaskType;
  localPrompt: string;
  executor: "requester-local";
  context: {
    roomEventSeq: number;
    selectedRoomEventIds: string[];
    workspaceSnapshotId?: string;
    reviewPointId?: string;
  };
  state: SideTaskState;
  publication: SideTaskPublication;
  requestedBy: string;
  createdAt: number;
}

export interface TaskArtifact {
  artifactId: string;
  taskId: string;
  kind: "findings" | "explanation";
  contentHash: string;
  createdAt: number;
}

export interface AcceptedTaskResult {
  taskId: string;
  workspaceSnapshotId?: string;
  summary: string;
  findings: ReviewFinding[];
  acceptedBy: string;
}

export type CollaborationEvent = {
  type: "workspace-sharing.changed";
  state: WorkspaceSharingState;
};

export interface CollaborationStreamFrame {
  kind: "collaboration-event";
  event: CollaborationEvent;
}
