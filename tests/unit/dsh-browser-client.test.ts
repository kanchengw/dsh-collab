import { describe, expect, it, vi } from "vitest";
import { createDshBrowserCollabClient as createBrowserClient, type BrowserFetch, type BrowserRequestInit, type BrowserSocket, type DshBrowserCollabOptions, type ParticipantResumeState } from "../../src/dsh-browser-client.js";
import { decodeCollabInvitation, encodeCollabInvitation } from "../../src/invitation.js";
import { CHANGE_SET_CAPABILITY, COLLAB_CAPABILITY_HEADER, SIDECAR_REVIEW_CAPABILITY } from "../../src/protocol.js";
import { projectCollabUnread } from "../../src/ui.js";

function response(data: unknown, status = 200): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: status < 400, status, json: async () => ({ protocol: "dsh-collab.v1", requestId: "test", ok: true, data }) };
}

function errorResponse(code: string, message: string, status: number): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: false, status, json: async () => ({ protocol: "dsh-collab.v1", requestId: "test", ok: false, error: { code, message } }) };
}

function createDshBrowserCollabClient(options: DshBrowserCollabOptions) {
  const fetch = options.fetch;
  return createBrowserClient({
    ...options,
    fetch: async (url, init) => url.endsWith("/stream-tickets")
      ? response({ ticket: "test-stream-ticket", expiresAt: 60_000 }, 201)
      : fetch!(url, init),
  });
}

describe("browser Gateway client", () => {
  it("accepts a Workspace Snapshot up to the shared 1 GiB total limit", async () => {
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({ room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token" });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/workspace-snapshots")) return response({ snapshot: {
        snapshotId: "a".repeat(64), roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0,
        manifestHash: "b".repeat(64), files: [{ path: "large.bin", contentHash: "c".repeat(64), size: 768 * 1024 * 1024, source: "tracked" }], createdAt: 1,
      } });
      throw new Error("unexpected request: " + url);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {} close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();
    await expect(client.requestWorkspaceSnapshot("room-1")).resolves.toMatchObject({ roomId: "room-1", files: [{ size: 768 * 1024 * 1024 }] });
    client.dispose();
  });

  it("establishes EasyTier before joining and reconnects a saved room only after an explicit action", async () => {
    const network = {
      mode: "easytier" as const,
      version: 1 as const,
      networkName: "dsh-collab-room-2",
      networkSecret: "network-secret-room-2",
      ownerVirtualAddress: "10.231.0.1",
      sharedNode: "tcp://public.kkrainbow.top:11010",
    };
    const invitation = encodeCollabInvitation({
      protocol: "dsh-collab.invitation.v2",
      type: "invite",
      gatewayEndpoint: "ws://10.231.0.1:4310/collab",
      roomId: "room-2",
      inviteId: "invite-2",
      token: "invite-token",
      expiresAt: 100,
      network,
    });
    let persisted: ParticipantResumeState | undefined;
    const transport = {
      startParticipant: vi.fn(async () => ({ gatewayEndpoint: "ws://127.0.0.1:45231/collab", localVirtualAddress: "10.231.2.3" })),
      stop: vi.fn(async () => {}),
    };
    const urls: string[] = [];
    const fetch: BrowserFetch = async (url) => {
      urls.push(url);
      if (url.endsWith("/join")) return response({ room: { roomId: "room-2", title: "Remote" }, member: { memberId: "member-bob", role: "participant" }, roomToken: "room-token", resumeCredential: "resume-secret" }, 201);
      if (url.endsWith("/resume")) return response({ room: { roomId: "room-2", title: "Remote" }, member: { memberId: "member-bob", role: "participant" }, roomToken: "room-token-2" });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor(public readonly url: string) { queueMicrotask(() => this.onopen?.()); }
      send(): void {} close(): void { this.readyState = 3; }
    };
    const persistence = {
      load: () => persisted,
      save: vi.fn(async (state: ParticipantResumeState) => { persisted = structuredClone(state); }),
      remove: vi.fn(async () => { persisted = undefined; }),
    };
    const first = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket, participantPersistence: persistence, easyTierTransport: transport });

    await first.join({ invitation, displayName: "Bob" });

    const secondInvitation = encodeCollabInvitation({
      protocol: "dsh-collab.invitation.v2",
      type: "invite",
      gatewayEndpoint: "ws://10.231.0.1:4310/collab",
      roomId: "room-3",
      inviteId: "invite-3",
      token: "invite-token-3",
      expiresAt: 100,
      network,
    });
    await expect(first.join({ invitation: secondInvitation, displayName: "Bob" })).rejects.toThrow("another collaboration room is already active");
    expect(transport.startParticipant).toHaveBeenCalledTimes(1);

    expect(transport.startParticipant).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-2", gatewayPort: 4310, network }));
    expect(urls.every((url) => url.startsWith("http://127.0.0.1:45231/collab"))).toBe(true);
    expect(persisted).toMatchObject({
      gatewayEndpoint: "ws://10.231.0.1:4310/collab",
      easyTier: { network, localVirtualAddress: "10.231.2.3" },
    });
    const disconnected = first.disconnectJoinedRoom();
    expect(disconnected).toBeInstanceOf(Promise);
    await disconnected;
    expect(transport.stop).toHaveBeenCalledOnce();

    transport.startParticipant.mockClear();
    urls.length = 0;
    const restarted = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket, participantPersistence: persistence, easyTierTransport: transport });
    expect(transport.startParticipant).not.toHaveBeenCalled();
    expect(urls).toHaveLength(0);

    await restarted.connectJoinedRoom({ gatewayEndpoint: persisted!.gatewayEndpoint, roomId: persisted!.roomId });
    expect(transport.startParticipant).toHaveBeenCalledWith(expect.objectContaining({ localVirtualAddress: "10.231.2.3" }));
    await restarted.forgetJoinedRoom({ gatewayEndpoint: persisted!.gatewayEndpoint, roomId: persisted!.roomId });
    expect(transport.stop).toHaveBeenCalledTimes(2);
    expect(persisted).toBeUndefined();
  });
  it("rolls back EasyTier and temporary credentials when Participant join fails after transport startup", async () => {
    const network = {
      mode: "easytier" as const,
      version: 1 as const,
      networkName: "dsh-collab-room-failed",
      networkSecret: "network-secret-failed",
      ownerVirtualAddress: "10.231.0.1",
      sharedNode: "tcp://public.kkrainbow.top:11010",
    };
    let persisted: ParticipantResumeState | undefined;
    const transport = {
      startParticipant: vi.fn(async () => ({ gatewayEndpoint: "ws://127.0.0.1:45231/collab", localVirtualAddress: "10.231.2.4" })),
      stop: vi.fn(async () => {}),
    };
    const client = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab",
      roomId: "dsh-room",
      fetch: async (url) => url.endsWith("/join")
        ? errorResponse("AUTH_INVALID", "invitation rejected", 401)
        : (() => { throw new Error(`unexpected request: ${url}`); })(),
      WebSocket: class {} as never,
      participantPersistence: {
        load: () => persisted,
        save: async (state) => { persisted = state; },
        remove: async () => { persisted = undefined; },
      },
      easyTierTransport: transport,
    });

    const invitation = encodeCollabInvitation({
      protocol: "dsh-collab.invitation.v2",
      type: "invite",
      gatewayEndpoint: "ws://10.231.0.1:4310/collab",
      roomId: "room-failed",
      inviteId: "invite-failed",
      token: "invite-token-failed",
      expiresAt: 100,
      network,
    });
    await expect(client.join({ invitation, displayName: "Bob" })).rejects.toThrow("invitation rejected");

    expect(transport.startParticipant).toHaveBeenCalledOnce();
    expect(transport.stop).toHaveBeenCalledOnce();
    expect(persisted).toBeUndefined();
    expect(client.getSnapshot().connection).toBe("offline");
  });

  it("keeps settings-port room actions callable when passed as callbacks", async () => {
    const fetch: BrowserFetch = async () => response({});
    const WebSocket = class implements BrowserSocket {
      readyState = 3;
      send(): void {}
      close(): void {}
    };
    const settings = createBrowserClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket }).settingsPort();
    const forgetJoinedRoom = settings.forgetJoinedRoom;

    await expect(forgetJoinedRoom({ gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomId: "room-1" })).resolves.toBeUndefined();
  });
  it("publishes, lists and accepts SideTask findings through validated contracts", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const reviewPointId = "d".repeat(64);
    let integrationRequestId = "9".repeat(64);
    const publication = {
      publicationId: "f".repeat(64), roomId: "room-1", reviewPointId, taskId: "task-review-1",
      workspaceSnapshotId: "a".repeat(64), publishedBy: "member-bob", summary: "One issue.",
      findingIds: ["e".repeat(64)], state: "published", createdAt: 30,
    };
    const finding = {
      findingId: "e".repeat(64), roomId: "room-1", reviewPointId, authorId: "member-bob", severity: "high",
      location: { kind: "line", path: "src/parser.ts", line: 2 }, body: "Recovery skips the token.", state: "accepted",
      createdAt: 30, decidedBy: "member-host", decidedAt: 31,
    };
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/bootstrap")) return response({ room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token" });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/publications") && init?.method === "POST") return response({ publication }, 201);
      if (url.endsWith("/publications") && init?.method === "GET") return response({ publications: [publication] });
      if (url.endsWith(`/publications/${publication.publicationId}/state`)) return response({
        publication: { ...publication, state: "accepted", acceptedBy: "member-host", acceptedAt: 31, integrationRequestId },
        findings: [finding],
      });
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {} close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();
    const input = {
      taskId: "task-review-1", workspaceSnapshotId: "a".repeat(64), summary: "One issue.",
      findings: [{ severity: "high" as const, location: { kind: "line" as const, path: "src/parser.ts", line: 2 }, body: "Recovery skips the token." }],
    };

    await expect(client.publishReviewPublication("room-1", reviewPointId, input)).resolves.toEqual(publication);
    await expect(client.listReviewPublications("room-1", reviewPointId)).resolves.toEqual({ publications: [publication] });
    await expect(client.acceptReviewPublication("room-1", reviewPointId, publication.publicationId)).rejects.toThrow(/publication/i);
    integrationRequestId = `internal:mainline:${"8".repeat(64)}`;
    await expect(client.acceptReviewPublication("room-1", reviewPointId, publication.publicationId)).resolves.toMatchObject({
      publication: { state: "accepted", integrationRequestId }, findings: [{ state: "accepted" }],
    });
    expect(requests.filter(({ url }) => url.includes("/publications"))).toHaveLength(4);
    client.dispose();
  });

  it("rejects cross-room or inconsistent Review publications at the browser boundary", async () => {
    const reviewPointId = "d".repeat(64);
    let payload: unknown = { publications: [] };
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({ room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token" });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/publications")) return response(payload);
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {} close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();
    const publication = {
      publicationId: "f".repeat(64), roomId: "room-other", reviewPointId, taskId: "task-review-1",
      workspaceSnapshotId: "a".repeat(64), publishedBy: "member-bob", summary: "One issue.",
      findingIds: ["e".repeat(64)], state: "published", createdAt: 30,
    };

    payload = { publications: [publication] };
    await expect(client.listReviewPublications("room-1", reviewPointId)).rejects.toThrow("invalid");
    payload = { publications: [{ ...publication, roomId: "room-1", state: "accepted", acceptedBy: "member-host", acceptedAt: 31 }] };
    await expect(client.listReviewPublications("room-1", reviewPointId)).rejects.toThrow("invalid");
    client.dispose();
  });

  it("creates, lists and decides Human Review findings through validated contracts", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const point = {
      reviewPointId: "d".repeat(64), roomId: "room-1", title: "Parser review", createdBy: "member-host", reviewerIds: [], lifecycle: "open",
      roomEventSeq: 3, mainAgentSessionId: "session-1", workspaceSnapshotId: "a".repeat(64), headOid: "b".repeat(40),
      files: [{ path: "src/parser.ts", status: "modified", snapshotContentHash: "c".repeat(64), additions: 4, deletions: 1 }], createdAt: 20,
    };
    const finding = {
      findingId: "e".repeat(64), roomId: "room-1", reviewPointId: point.reviewPointId, authorId: "member-bob", severity: "high",
      location: { kind: "line", path: "src/parser.ts", line: 2 }, body: "Recovery skips the token.", state: "open", createdAt: 30,
    };
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/bootstrap")) return response({ room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token" });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/findings") && init?.method === "POST") return response({ finding }, 201);
      if (url.includes("/findings?") && init?.method === "GET") return response({ findings: [finding] });
      if (url.endsWith("/reviewers")) return response({ reviewPoint: { ...point, reviewerIds: ["member-bob"] } });
      if (url.endsWith("/lifecycle")) return response({ reviewPoint: { ...point, lifecycle: "changes-requested" } });
      if (url.endsWith(`/findings/${finding.findingId}/state`)) return response({ finding: { ...finding, state: "accepted", decidedBy: "member-host", decidedAt: 31 } });
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {} close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.createReviewFinding("room-1", point.reviewPointId, { severity: "high", location: { kind: "line", path: "src/parser.ts", line: 2 }, body: "Recovery skips the token." })).resolves.toEqual(finding);
    await expect(client.listReviewFindings("room-1", point.reviewPointId)).resolves.toEqual({ findings: [finding] });
    await expect(client.setReviewers("room-1", point.reviewPointId, ["member-bob"])).resolves.toMatchObject({ reviewerIds: ["member-bob"] });
    await expect(client.setReviewLifecycle("room-1", point.reviewPointId, "changes-requested")).resolves.toMatchObject({ lifecycle: "changes-requested" });
    await expect(client.setReviewFindingState("room-1", point.reviewPointId, finding.findingId, "accepted")).resolves.toMatchObject({ state: "accepted", decidedBy: "member-host" });
    expect(requests.filter(({ url }) => url.includes(point.reviewPointId))).toHaveLength(5);
    client.dispose();
  });

  it("creates, lists and refreshes Review Points through the active room token", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const reviewPoint = {
      reviewPointId: "d".repeat(64), roomId: "room-1", title: "Parser review", focus: "Correctness", createdBy: "member-host", reviewerIds: [], lifecycle: "open",
      roomEventSeq: 3, mainAgentSessionId: "session-1", workspaceSnapshotId: "a".repeat(64), headOid: "b".repeat(40),
      files: [{ path: "src/parser.ts", status: "modified", snapshotContentHash: "c".repeat(64), additions: 4, deletions: 1 }], createdAt: 20,
    };
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/bootstrap")) return response({ room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token" });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/review-points/refresh")) return response({ snapshotId: "e".repeat(64) });
      if (url.endsWith(`/review-points/${reviewPoint.reviewPointId}/diffs/0`)) return response({ diff: { path: "src/parser.ts", kind: "text", oldText: "old\n", newText: "new\n" } });
      if (url.endsWith(`/review-points/${reviewPoint.reviewPointId}/diffs/1`)) return response({ diff: { path: "src/legacy.ts", kind: "unavailable" } });
      if (url.endsWith("/review-points") && init?.method === "POST") return response({ reviewPoint }, 201);
      if (url.includes("/review-points?")) return response({ reviewPoints: [{ reviewPoint, freshness: "current", progress: { roomEventDelta: 2, workspaceChangedFileCount: 1 } }] });
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.createReviewPoint("room-1", { title: "Parser review", focus: "Correctness", files: [{ path: "src/parser.ts", status: "modified", additions: 4, deletions: 1 }] })).resolves.toEqual(reviewPoint);
    await expect(client.listReviewPoints("room-1")).resolves.toMatchObject({ reviewPoints: [{ freshness: "current", progress: { roomEventDelta: 2, workspaceChangedFileCount: 1 } }] });
    await expect(client.refreshReviewPoints("room-1")).resolves.toBe("e".repeat(64));
    await expect(client.loadReviewPointDiff("room-1", reviewPoint.reviewPointId, 0)).resolves.toEqual({ path: "src/parser.ts", kind: "text", oldText: "old\n", newText: "new\n" });
    await expect(client.loadReviewPointDiff("room-1", reviewPoint.reviewPointId, 1)).resolves.toEqual({ path: "src/legacy.ts", kind: "unavailable" });
    expect(requests.filter(({ url }) => url.includes("review-points"))).toHaveLength(5);
    expect(requests.filter(({ url, init }) => url.includes("review-points") && init?.headers?.[COLLAB_CAPABILITY_HEADER] === `${SIDECAR_REVIEW_CAPABILITY},${CHANGE_SET_CAPABILITY}`)).toHaveLength(5);
    client.dispose();
  });

  it("reuses a Review Point command ID after a lost response", async () => {
    const bodies: string[] = [];
    const refreshBodies: string[] = [];
    let attempts = 0;
    const reviewPoint = {
      reviewPointId: "d".repeat(64), roomId: "room-1", title: "Parser review", createdBy: "member-host", reviewerIds: [], lifecycle: "open",
      roomEventSeq: 3, mainAgentSessionId: "session-1", workspaceSnapshotId: "a".repeat(64), headOid: "b".repeat(40),
      files: [{ path: "src/parser.ts", status: "modified", snapshotContentHash: "c".repeat(64), additions: 4, deletions: 1 }], createdAt: 20,
    };
    const fetch: BrowserFetch = async (url, init) => {
      if (url.endsWith("/bootstrap")) return response({ room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token" });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/review-points/refresh")) {
        refreshBodies.push(String(init?.body));
        if (refreshBodies.length === 1) throw new Error("response lost");
        return response({ snapshotId: "e".repeat(64) });
      }
      if (url.endsWith("/review-points")) {
        bodies.push(String(init?.body));
        attempts += 1;
        if (attempts === 1) throw new Error("response lost");
        return response({ reviewPoint }, 201);
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {} close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();
    const input = { title: "Parser review", files: [{ path: "src/parser.ts", status: "modified" as const, additions: 4, deletions: 1 }] };

    await expect(client.createReviewPoint("room-1", input)).rejects.toThrow("Gateway");
    await expect(client.createReviewPoint("room-1", input)).resolves.toEqual(reviewPoint);
    expect(JSON.parse(bodies[0]!).clientRequestId).toBe(JSON.parse(bodies[1]!).clientRequestId);
    await expect(client.refreshReviewPoints("room-1")).rejects.toThrow("Gateway");
    await expect(client.refreshReviewPoints("room-1")).resolves.toBe("e".repeat(64));
    expect(JSON.parse(refreshBodies[0]!).clientRequestId).toBe(JSON.parse(refreshBodies[1]!).clientRequestId);
    client.dispose();
  });

  it("rejects malformed Review Point pages at the browser boundary", async () => {
    const point = {
      reviewPointId: "d".repeat(64), roomId: "room-1", title: "Parser review", createdBy: "member-host", reviewerIds: [], lifecycle: "open",
      roomEventSeq: 3, mainAgentSessionId: "session-1", workspaceSnapshotId: "a".repeat(64), headOid: "b".repeat(40),
      files: [{ path: "src/parser.ts", status: "modified", snapshotContentHash: "c".repeat(64), additions: 4, deletions: 1 }], createdAt: 20,
    };
    let page: unknown = { reviewPoints: [] };
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({ room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token" });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.includes("/review-points?")) return response(page);
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    const projection = { reviewPoint: point, freshness: "current", progress: { roomEventDelta: 0, workspaceChangedFileCount: 0 } };
    const malformed = [
      { reviewPoints: [{ ...projection, progress: { ...projection.progress, roomEventDelta: -1 } }] },
      { reviewPoints: [{ ...projection, reviewPoint: { ...point, lifecycle: "pending" } }] },
      { reviewPoints: [{ ...projection, reviewPoint: { ...point, files: [{ ...point.files[0], path: "../secret" }] } }] },
      { reviewPoints: [{ ...projection, reviewPoint: { ...point, files: [point.files[0], point.files[0]] } }] },
      { reviewPoints: [{ ...projection, reviewPoint: { ...point, workspaceSnapshotId: "bad/id" } }] },
      { reviewPoints: [{ ...projection, reviewPoint: { ...point, headOid: "not-an-oid" } }] },
      { reviewPoints: Array.from({ length: 101 }, () => projection) },
      { reviewPoints: [], nextCursor: "bad-cursor" },
    ];
    for (const value of malformed) {
      page = value;
      await expect(client.listReviewPoints("room-1")).rejects.toThrow("invalid");
    }
    client.dispose();
  });

  it("rejects oversized or negative Workspace Snapshot metadata", async () => {
    let snapshot: Record<string, unknown> = {
      snapshotId: "a".repeat(64), roomId: "room-1", hostSessionId: "session-1", roomEventSeq: -1,
      manifestHash: "b".repeat(64), files: [], createdAt: 20,
    };
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/workspace-snapshots")) return response({ snapshot }, 201);
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.requestWorkspaceSnapshot("room-1")).rejects.toThrow("invalid");
    snapshot = {
      ...snapshot,
      roomEventSeq: 0,
      createdAt: -1,
    };
    await expect(client.requestWorkspaceSnapshot("room-1")).rejects.toThrow("invalid");
    snapshot = {
      ...snapshot,
      createdAt: 20,
      files: Array.from({ length: 10_001 }, (_, index) => ({ path: `src/${String(index)}.ts`, contentHash: "c".repeat(64), size: 0, source: "tracked" })),
    };
    const manyFiles = await client.requestWorkspaceSnapshot("room-1");
    expect(manyFiles.files).toHaveLength(10_001);
    expect(manyFiles.files.at(-1)).toMatchObject({ path: "src/10000.ts" });
    snapshot = {
      ...snapshot,
      files: [
        { path: "src/a.ts", contentHash: "c".repeat(64), size: 512 * 1024 * 1024 + 1, source: "tracked" },
        { path: "src/b.ts", contentHash: "d".repeat(64), size: 512 * 1024 * 1024, source: "tracked" },
      ],
    };
    await expect(client.requestWorkspaceSnapshot("room-1")).rejects.toThrow("invalid");
    client.dispose();
  });

  it("reads, changes and follows Workspace Sharing before loading an immutable snapshot", async () => {
    let socket: BrowserSocket | undefined;
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/workspace-sharing") && init?.method === "POST") return response({ state: { roomId: "room-1", enabled: true, enabledBy: "host", enabledAt: 10, revision: 1 } });
      if (url.endsWith("/workspace-sharing")) return response({ state: { roomId: "room-1", enabled: false, revision: 0 } });
      if (url.endsWith("/workspace-snapshots")) return response({ snapshot: {
        snapshotId: "a".repeat(64), roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 3,
        manifestHash: "b".repeat(64), files: [], createdAt: 20,
      } }, 201);
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.getWorkspaceSharing("room-1")).resolves.toEqual({ roomId: "room-1", enabled: false, revision: 0 });
    await expect(client.setWorkspaceSharing("room-1", true)).resolves.toMatchObject({ enabled: true, revision: 1 });
    await expect(client.requestWorkspaceSnapshot("room-1")).resolves.toMatchObject({ snapshotId: "a".repeat(64), roomEventSeq: 3 });
    socket?.onmessage?.({ data: JSON.stringify({
      protocol: "dsh-collab.v1",
      type: "event",
      event: {
        eventId: "workspace-sharing:room-1:2", roomId: "room-1", seq: 1, type: "workspace-sharing.changed",
        actor: { memberId: "member-host", principalId: "host" }, createdAt: 20,
        payload: { roomId: "room-1", enabled: false, revision: 2 },
      },
    }) });
    socket?.onmessage?.({ data: JSON.stringify({
      protocol: "dsh-collab.v1",
      type: "event",
      event: {
        eventId: `changeset-review-assigned:${"b".repeat(64)}`, roomId: "room-1", seq: 2, type: "changeset.review-assigned",
        actor: { memberId: "member-host", principalId: "host" }, createdAt: 21,
        payload: {
          assignmentId: "b".repeat(64), changeSetId: "a".repeat(64), assignedBy: "member-host", reviewerId: "member-reviewer", createdAt: 21,
        },
      },
    }) });

    expect(client.getSnapshot().workspaceSharing).toEqual({ roomId: "room-1", enabled: false, revision: 2 });
    expect(client.getSnapshot().roomEvents?.map((event) => event.type)).toEqual(["workspace-sharing.changed", "changeset.review-assigned"]);
    expect(requests.filter(({ init }) => init?.headers?.[COLLAB_CAPABILITY_HEADER] === `${SIDECAR_REVIEW_CAPABILITY},${CHANGE_SET_CAPABILITY}`)).toHaveLength(requests.length);
    expect(requests.filter(({ url }) => url.endsWith("/workspace-snapshots"))[0]?.init?.body).toContain("clientRequestId");
    client.dispose();
  });

  it("does not let a delayed Workspace Sharing response overwrite a newer stream revision", async () => {
    let socket: BrowserSocket | undefined;
    let resolveSharing: ((value: ReturnType<typeof response>) => void) | undefined;
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({ room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token" });
      if (url.endsWith("/snapshot") && !url.includes("workspace-snapshots")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/workspace-sharing")) return await new Promise((resolve) => { resolveSharing = resolve; });
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
      send(): void {} close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();
    const pending = client.getWorkspaceSharing("room-1");
    socket?.onmessage?.({ data: JSON.stringify({
      protocol: "dsh-collab.v1", type: "event",
      event: {
        eventId: "workspace-sharing:room-1:2", roomId: "room-1", seq: 1, type: "workspace-sharing.changed",
        actor: { memberId: "member-host", principalId: "host" }, createdAt: 20,
        payload: { roomId: "room-1", enabled: true, enabledBy: "member-host", enabledAt: 20, revision: 2 },
      },
    }) });
    resolveSharing?.(response({ state: { roomId: "room-1", enabled: false, revision: 1 } }));

    await expect(pending).resolves.toMatchObject({ revision: 1 });
    expect(client.getSnapshot().workspaceSharing).toMatchObject({ enabled: true, revision: 2 });
    client.dispose();
  });

  it("uses live presence instead of persisted memberships for the online count", async () => {
    let socket: BrowserSocket | undefined;
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        members: [
          { memberId: "member-host", role: "host", status: "active" },
          { memberId: "member-old-a", role: "participant", status: "active" },
          { memberId: "member-old-b", role: "participant", status: "active" },
        ],
        lastEventSeq: 0,
      });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });

    await client.bootstrap();
    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "presence", roomId: "room-1", onlineMemberCount: 1 }) });

    expect(client.getSnapshot()).toMatchObject({ onlineCount: 1 });
    client.dispose();
  });

  it("connects, disconnects and forgets a saved Joined room only on explicit actions", async () => {
    const saved: ParticipantResumeState[] = [
      { gatewayEndpoint: "wss://one.example/collab", roomId: "room-1", memberId: "member-1", credential: "secret-1", roomTitle: "Design" },
      { gatewayEndpoint: "wss://two.example/collab", roomId: "room-2", memberId: "member-2", credential: "secret-2", roomTitle: "Release" },
    ];
    const requests: string[] = [];
    const fetch: BrowserFetch = async (url) => {
      requests.push(url);
      if (url.endsWith("/resume")) return response({ room: { roomId: "room-2", title: "Release" }, member: { memberId: "member-2", role: "participant" }, roomToken: "token-2" });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-2", title: "Release" }, members: [], lastEventSeq: 0 });
      return response({ events: [], nextSeq: 0 });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onclose?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const persistence = {
      load: (ref?: { gatewayEndpoint: string; roomId: string }) => ref ? saved.find((room) => room.gatewayEndpoint === ref.gatewayEndpoint && room.roomId === ref.roomId) : saved[0],
      list: () => saved,
      save: async () => {},
      remove: async (ref: { gatewayEndpoint: string; roomId: string }) => { const index = saved.findIndex((room) => room.gatewayEndpoint === ref.gatewayEndpoint && room.roomId === ref.roomId); if (index >= 0) saved.splice(index, 1); },
    };
    const easyTierTransport = { startParticipant: vi.fn(), stop: vi.fn(async () => {}) };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket, participantPersistence: persistence, easyTierTransport });
    expect(client.listJoinedRooms()).toHaveLength(2);
    expect(requests).toEqual([]);

    const selected = { gatewayEndpoint: "wss://two.example/collab", roomId: "room-2" };
    await client.connectJoinedRoom(selected);
    expect(client.getSnapshot()).toMatchObject({ roomId: "room-2", role: "participant", connection: "online" });
    await client.disconnectJoinedRoom();
    expect(client.getSnapshot().connection).toBe("offline");
    await client.forgetJoinedRoom(selected);
    expect(client.listJoinedRooms()).toEqual([expect.objectContaining({ roomId: "room-1" })]);
    expect(easyTierTransport.stop).not.toHaveBeenCalled();
  });

  it("stops sharing without deleting the saved Host room", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/host") && init?.method === "POST") return response({ room: { roomId: "room-current", title: "Room" }, member: { memberId: "host", role: "host" }, roomToken: "token" });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-current", title: "Room" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      return response({ sharing: false });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onclose?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket });
    await client.shareHostRoom({ roomId: "room-current", hostSessionId: "session-current", title: "Room" });
    await client.stopSharing("room-current");

    expect(requests.at(-1)).toMatchObject({ url: "http://127.0.0.1:4310/collab/v1/rooms/room-current/host", init: { method: "DELETE" } });
    expect(client.getSnapshot()).toMatchObject({ connection: "offline" });
  });

  it("shares the exact current DSH session and trimmed Room name", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/host")) return response({
        room: { roomId: "room-opaque", title: "Release room", hostDisplayName: "Host" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      return response({ room: { roomId: "room-opaque", title: "Release room" }, members: [], lastEventSeq: 0 });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket });

    await client.shareHostRoom({ roomId: "room-opaque", hostSessionId: "session-current", title: "  Release room  " });

    expect(requests[0]?.url).toBe("http://127.0.0.1:4310/collab/v1/rooms/room-opaque/host");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ hostSessionId: "session-current", title: "Release room" });
    expect(client.getSnapshot()).toMatchObject({ roomId: "room-opaque", roomTitle: "Release room", role: "host", connection: "online" });
    client.dispose();
  });

  it("keeps the active Host room when sharing another session fails", async () => {
    const requests: string[] = [];
    const fetch: BrowserFetch = async (url) => {
      requests.push(url);
      if (url.endsWith("/room-1/bootstrap")) return response({
        room: { roomId: "room-1", title: "Current room" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      if (url.endsWith("/room-denied/host")) return response({}, 403);
      if (url.endsWith("/room-1/snapshot")) return response({ room: { roomId: "room-1", title: "Current room" }, members: [], lastEventSeq: 0 });
      if (url.endsWith("/room-1/invites")) return response({ invite: { inviteId: "invite-1", roomId: "room-1", expiresAt: 100 }, token: "invite-secret" }, 201);
      throw new Error(`unexpected request ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.shareHostRoom({ roomId: "room-denied", hostSessionId: "session-denied", title: "Denied" })).rejects.toThrow("another collaboration room is already active");
    await client.createInvite({ inviteId: "invite-1", expiresAt: 100, gatewayEndpoint: "ws://192.168.1.20:4310/collab" });

    expect(requests.at(-1)).toBe("http://127.0.0.1:4310/collab/v1/rooms/room-1/invites");
    client.dispose();
  });

  it("manages another owned room without changing the active collaboration connection", async () => {
    const requests: string[] = [];
    const fetch: BrowserFetch = async (url) => {
      requests.push(url);
      if (url.endsWith("/room-active/bootstrap")) return response({
        room: { roomId: "room-active", title: "Active room" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      if (url.endsWith("/room-active/snapshot")) return response({ room: { roomId: "room-active", title: "Active room" }, members: [], lastEventSeq: 0 });
      if (url.endsWith("/room-other/invites")) return response({ invite: { inviteId: "invite-other", roomId: "room-other", expiresAt: 100 }, token: "invite-secret" }, 201);
      if (url.endsWith("/room-other/host")) return response({ sharing: false });
      if (url.endsWith("/room-active/messages")) return response({ message: { text: "still active" } }, 201);
      throw new Error(`unexpected request ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-active", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.createInvite({ inviteId: "invite-other", expiresAt: 100, gatewayEndpoint: "ws://192.168.1.20:4310/collab" }, "room-other"))
      .rejects.toThrow("active Host room");
    await client.send({ text: "still active", target: "room" });

    expect(client.getSnapshot()).toMatchObject({ roomId: "room-active", connection: "online" });
    expect(requests.at(-1)).toBe("http://127.0.0.1:4310/collab/v1/rooms/room-active/messages");
    client.dispose();
  });

  it("bootstraps a Host, connects with a one-time stream ticket, and sends an Agent request", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const socketUrls: string[] = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-room-token",
      });
      if (url.endsWith("/snapshot")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        members: [{ memberId: "member-host", role: "host", displayName: "Local Host" }],
        lastEventSeq: 0,
      });
      if (url.endsWith("/stream-tickets")) return response({ ticket: "stream-ticket", expiresAt: 100 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/invites")) return response({ invite: { inviteId: "invite-1", roomId: "room-1", expiresAt: 100 }, token: "invite-secret" }, 201);
      return response({ request: { requestId: "request-1" } }, 202);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(readonly url: string) { socketUrls.push(url); queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; this.onclose?.(); }
    };
    const client = createBrowserClient({ gatewayUrl: "http://127.0.0.1:3080/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();
    expect(client.getSnapshot()).toMatchObject({ members: [{ memberId: "member-host", displayName: "Local Host" }] });
    expect(client.getSnapshot()).toMatchObject({ roomId: "room-1", memberId: "member-host", role: "host", connection: "online", canSteer: true });
    await client.send({ text: "run tests", target: "dsh", contextRefs: ["event-1", "event-2"] });
    expect(requests.at(-1)?.url).toBe("http://127.0.0.1:3080/collab/v1/rooms/room-1/messages");
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toMatchObject({ text: "run tests", target: "dsh", contextRefs: ["event-1", "event-2"] });
    expect(socketUrls[0]).toContain("ticket=stream-ticket");
    expect(socketUrls[0]).not.toContain("host-room-token");
    expect(requests.find(({ url }) => url.endsWith("/stream-tickets"))?.init?.headers?.authorization).toBe("Bearer host-room-token");
    expect(new URL(socketUrls[0]!).searchParams.getAll("feature")).not.toContain("agent-output");
    expect(new URL(socketUrls[0]!).searchParams.getAll("feature")).toContain(SIDECAR_REVIEW_CAPABILITY);
    expect(new URL(socketUrls[0]!).searchParams.getAll("feature")).toContain(CHANGE_SET_CAPABILITY);
    expect(requests.every((request) => request.init?.headers?.[COLLAB_CAPABILITY_HEADER] === `${SIDECAR_REVIEW_CAPABILITY},${CHANGE_SET_CAPABILITY}`)).toBe(true);
    const created = await client.createInvite({ inviteId: "invite-1", expiresAt: 100, gatewayEndpoint: "ws://192.168.1.20:4310/collab" });
    expect(decodeCollabInvitation(created.invitation)).toMatchObject({ gatewayEndpoint: "ws://192.168.1.20:4310/collab", roomId: "room-1", inviteId: "invite-1", token: "invite-secret" });
    client.dispose();
  });

  it("reuses a human message ID after a lost response", async () => {
    const messageBodies: Array<Record<string, unknown>> = [];
    const fetch: BrowserFetch = async (url, init) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/messages")) {
        messageBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (messageBodies.length === 1) throw new TypeError("network response was lost");
        return response({ message: { text: "hello team" } }, 201);
      }
      throw new Error(`unexpected request ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.send({ text: "hello team", target: "room" })).rejects.toThrow("Gateway is unreachable");
    await client.send({ text: "hello team", target: "room" });

    expect(messageBodies).toHaveLength(2);
    expect(messageBodies[1]?.clientMessageId).toBe(messageBodies[0]?.clientMessageId);
    client.dispose();
  });

  it("reuses an Agent request ID after a lost response", async () => {
    const messageBodies: Array<Record<string, unknown>> = [];
    const fetch: BrowserFetch = async (url, init) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/messages")) {
        messageBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (messageBodies.length === 1) throw new TypeError("network response was lost");
        return response({ request: { status: "queued" } }, 202);
      }
      throw new Error(`unexpected request ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.send({ text: "run tests", target: "dsh" })).rejects.toThrow("Gateway is unreachable");
    await client.send({ text: "run tests", target: "dsh" });

    expect(messageBodies).toHaveLength(2);
    expect(messageBodies[1]?.clientMessageId).toBe(messageBodies[0]?.clientMessageId);
    client.dispose();
  });

  it("retains saved Joined rooms after opening the local Host room", async () => {
    let persisted: ParticipantResumeState | undefined = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };
    const fetch: BrowserFetch = async (url) => url.endsWith("/bootstrap") ? response({
      room: { roomId: "room-1", title: "Local" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token",
    }) : response({ room: { roomId: "room-1", title: "Local" }, members: [], lastEventSeq: 0 });
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket,
      participantPersistence: { load: () => persisted, save: async (state) => { persisted = state; }, clear: async () => { persisted = undefined; } },
    });
    await client.bootstrap();
    expect(client.getSnapshot().role).toBe("host");
    expect(persisted).toMatchObject({ roomId: "room-2", credential: "resume-secret" });
  });

  it("joins as a Participant with its own principal and never enables steer", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/join")) return response({
        room: { roomId: "room-2", title: "Release", hostDisplayName: "Host" },
        member: { memberId: "member-bob", role: "participant" },
        roomToken: "bob-room-token",
      }, 201);
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      return response({
        room: { roomId: "room-2", title: "Release" },
        members: [{ memberId: "member-host", role: "host", displayName: "Local Host" }],
        lastEventSeq: 0,
      });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; this.onclose?.(); }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:3080/collab", roomId: "room-1", role: "participant", fetch, WebSocket });
    await client.join({
      invitation: JSON.stringify({ protocol: "dsh-collab.invitation.v2", type: "invite", gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", inviteId: "invite-1", token: "invite-token", expiresAt: 100, network: { mode: "custom-wss", version: 1, endpoint: "wss://collab.example/collab" } }),
      memberId: "member-bob",
      displayName: "Bob",
    });
    expect(client.getSnapshot()).toMatchObject({ role: "participant", canSteer: false, connection: "online", hostDisplayName: "Local Host" });
    expect(client.settingsPort().getLocalSnapshotAccess("room-2")).toEqual({ gatewayEndpoint: "wss://collab.example/collab", roomToken: "bob-room-token" });
    expect(requests[0]?.init?.headers).not.toHaveProperty("x-dsh-principal-id");
    expect(requests[0]?.url).toBe("https://collab.example/collab/v1/rooms/room-2/join");
  });

  it("persists the generated Join binding before a response can be lost", async () => {
    let persisted: ParticipantResumeState | undefined;
    let joinBody: Record<string, unknown> | undefined;
    const client = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab",
      roomId: "room-1",
      fetch: async (_url, init) => {
        joinBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        throw new TypeError("network response was lost");
      },
      WebSocket: class {} as never,
      participantPersistence: {
        load: () => persisted,
        save: async (state) => { persisted = state; },
      },
    });

    await expect(client.join({
      invitation: JSON.stringify({
        protocol: "dsh-collab.invitation.v2",
        type: "invite",
        gatewayEndpoint: "wss://collab.example/collab",
        roomId: "room-2",
        inviteId: "invite-retry",
        token: "invite-token",
        expiresAt: 100,
        network: { mode: "custom-wss", version: 1, endpoint: "wss://collab.example/collab" },
      }),
      displayName: "Retry User",
    })).rejects.toThrow("Gateway is unreachable");

    expect(persisted).toMatchObject({
      gatewayEndpoint: "wss://collab.example/collab",
      roomId: "room-2",
      memberId: expect.any(String),
      credential: expect.any(String),
    });
    expect(joinBody).toMatchObject({
      memberId: persisted?.memberId,
      resumeCredential: persisted?.credential,
    });
    client.dispose();
  });

  it("keeps the current room transport unchanged when joining an invitation fails", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Local" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-1", title: "Local" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/join")) return errorResponse("AUTH_INVALID", "invitation rejected", 401);
      if (url.endsWith("/messages")) return response({ request: { requestId: "request-1" } }, 202);
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {} close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.join({
      invitation: JSON.stringify({ protocol: "dsh-collab.invitation.v2", type: "invite", gatewayEndpoint: "ws://10.0.0.2:4312/collab", roomId: "room-2", inviteId: "invite-2", token: "invite-token", expiresAt: 100, network: { mode: "lan", version: 1, endpoint: "ws://10.0.0.2:4312/collab" } }),
      displayName: "Host",
    })).rejects.toThrow("another collaboration room is already active");
    await client.send({ text: "still local", target: "room" });

    expect(client.getSnapshot()).toMatchObject({ roomId: "room-1", role: "host", connection: "online" });
    expect(requests.at(-1)?.url).toBe("http://127.0.0.1:4310/collab/v1/rooms/room-1/messages");
    expect(requests.at(-1)?.init?.headers?.authorization).toBe("Bearer host-token");
    expect(requests.filter(({ url }) => url.startsWith("http://10.0.0.2:4312"))).toEqual([]);
    client.dispose();
  });

  it("keeps the current room active when a joined room snapshot cannot be loaded", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    let currentSocket: BrowserSocket | undefined;
    let persisted: ParticipantResumeState | undefined;
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Local" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      if (url.includes("/room-1/snapshot")) return response({ room: { roomId: "room-1", title: "Local" }, members: [], lastEventSeq: 0 });
      if (url.endsWith("/join")) return response({
        room: { roomId: "room-2", title: "Remote" },
        member: { memberId: "member-bob", role: "participant" },
        roomToken: "participant-token",
        resumeCredential: "resume-room-2",
      }, 201);
      if (url.includes("/room-2/snapshot")) return errorResponse("ROOM_INACTIVE", "room is not shared", 409);
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      if (url.endsWith("/messages")) return response({}, 201);
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() { currentSocket = this; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab",
      roomId: "room-1",
      fetch,
      WebSocket,
      participantPersistence: { load: () => persisted, save: async (state) => { persisted = state; } },
    });
    await client.bootstrap();
    const originalSocket = currentSocket;

    await expect(client.join({
      invitation: JSON.stringify({ protocol: "dsh-collab.invitation.v2", type: "invite", gatewayEndpoint: "ws://10.0.0.2:4312/collab", roomId: "room-2", inviteId: "invite-2", token: "invite-token", expiresAt: 100, network: { mode: "lan", version: 1, endpoint: "ws://10.0.0.2:4312/collab" } }),
      displayName: "Bob",
    })).rejects.toThrow("another collaboration room is already active");
    await client.send({ text: "still local", target: "room" });

    expect(client.getSnapshot()).toMatchObject({ roomId: "room-1", role: "host", connection: "online" });
    expect(persisted).toBeUndefined();
    expect(originalSocket?.readyState).toBe(1);
    expect(requests.at(-1)).toMatchObject({
      url: "http://127.0.0.1:4310/collab/v1/rooms/room-1/messages",
      init: { headers: { authorization: "Bearer host-token" } },
    });
    client.dispose();
  });

  it("keeps the current room socket when a joined room socket cannot open", async () => {
    const sockets: BrowserSocket[] = [];
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({ room: { roomId: "room-1", title: "Local" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token" });
      if (url.endsWith("/join")) return response({ room: { roomId: "room-2", title: "Remote" }, member: { memberId: "member-bob", role: "participant" }, roomToken: "participant-token" }, 201);
      const roomId = url.includes("/room-2/") ? "room-2" : "room-1";
      if (url.endsWith("/snapshot")) return response({ room: { roomId, title: roomId }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 0; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() {
        sockets.push(this);
        const attempt = sockets.length;
        queueMicrotask(() => {
          if (attempt === 1) { this.readyState = 1; this.onopen?.(); }
          else { this.readyState = 3; this.onclose?.(); }
        });
      }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.join({
      invitation: JSON.stringify({ protocol: "dsh-collab.invitation.v2", type: "invite", gatewayEndpoint: "ws://10.0.0.2:4312/collab", roomId: "room-2", inviteId: "invite-2", token: "invite-token", expiresAt: 100, network: { mode: "lan", version: 1, endpoint: "ws://10.0.0.2:4312/collab" } }),
      displayName: "Bob",
    })).rejects.toThrow("another collaboration room is already active");

    expect(client.getSnapshot()).toMatchObject({ roomId: "room-1", role: "host", connection: "online" });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.readyState).toBe(1);
    client.dispose();
  });

  it("recovers room events and projects live human and Agent output into the timeline", async () => {
    const requests: string[] = [];
    let socket: BrowserSocket | undefined;
    const fetch: BrowserFetch = async (url) => {
      requests.push(url);
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-room-token",
      });
      if (url.endsWith("/snapshot")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        members: [{ memberId: "member-host", role: "host", displayName: "Local Host" }],
        lastEventSeq: 2,
      });
      if (url.includes("/events?")) return response({ events: [
        { eventId: "human-1", roomId: "room-1", seq: 1, type: "human.message", actor: { memberId: "member-alice", principalId: "alice" }, createdAt: 1, payload: { text: "hello", mentions: ["member-host"] } },
        { eventId: "agent-1", roomId: "room-1", seq: 2, type: "agent.state.changed", actor: { memberId: "member-host", principalId: "host" }, createdAt: 2, payload: { requestId: "request-1", state: "output", text: "done" } },
      ] });
      throw new Error(`unexpected request ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(readonly url: string) { socket = this; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; this.onclose?.(); }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:3080/collab", roomId: "room-1", fetch, WebSocket });

    await client.bootstrap();
    expect(requests).toContain("http://127.0.0.1:3080/collab/v1/rooms/room-1/events?after=0&limit=500");
    expect(client.getSnapshot().timeline).toMatchObject([
      { kind: "human", text: "hello" },
      { kind: "agent", text: "done", state: "output" },
    ]);
    expect(client.getSnapshot().roomEvents?.map((event) => event.eventId)).toEqual(["human-1", "agent-1"]);
    expect(client.getSnapshot().lastReadSeq).toBe(2);
    expect(projectCollabUnread(client.getSnapshot().roomEvents ?? [], client.getSnapshot().memberId, client.getSnapshot().lastReadSeq)).toEqual({ personal: 0, total: 0 });

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "event", event: {
      eventId: "foreign", roomId: "room-2", seq: 999, type: "human.message",
      actor: { memberId: "member-other", principalId: "other" }, createdAt: 3, payload: { text: "wrong room" },
    } }) });
    expect(client.getSnapshot().timeline).toHaveLength(2);

    socket?.onmessage?.({ data: JSON.stringify({
      protocol: "dsh-collab.v1",
      type: "agent-output",
      roomId: "room-1",
      requestId: "request-2",
      text: "partial **answer",
      streaming: true,
    }) });
    expect(client.getSnapshot().timeline?.at(-1)).toMatchObject({ eventId: "stream:request-2", kind: "agent", requestId: "request-2", text: "partial **answer", streaming: true });

    socket?.onmessage?.({ data: JSON.stringify({
      protocol: "dsh-collab.v1",
      type: "agent-output",
      roomId: "room-1",
      requestId: "request-2",
      text: "partial **answer**",
      streaming: true,
    }) });
    expect(client.getSnapshot().timeline?.filter((item) => item.requestId === "request-2")).toHaveLength(1);

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "event", event: {
      eventId: "agent-2", roomId: "room-1", seq: 3, type: "agent.state.changed",
      actor: { memberId: "member-host", principalId: "host" }, createdAt: 3, payload: { requestId: "request-2", state: "output", text: "final **answer**" },
    } }) });
    expect(client.getSnapshot().timeline?.filter((item) => item.requestId === "request-2")).toEqual([
      expect.objectContaining({ eventId: "agent-2", text: "final **answer**", streaming: false }),
    ]);

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "event", event: {
      eventId: "human-2", roomId: "room-1", seq: 4, type: "human.message",
      actor: { memberId: "member-alice", principalId: "alice" }, createdAt: 4, payload: { text: "live", mentions: ["member-host"] },
    } }) });
    expect(client.getSnapshot().timeline?.at(-1)).toMatchObject({ kind: "human", text: "live" });
    expect(client.getSnapshot().roomEvents?.at(-1)?.eventId).toBe("human-2");
    expect(client.getSnapshot().lastReadSeq).toBe(2);
    expect(projectCollabUnread(client.getSnapshot().roomEvents ?? [], client.getSnapshot().memberId, client.getSnapshot().lastReadSeq)).toEqual({ personal: 1, total: 1 });
    client.markRead();
    expect(client.getSnapshot().lastReadSeq).toBe(4);
    expect(projectCollabUnread(client.getSnapshot().roomEvents ?? [], client.getSnapshot().memberId, client.getSnapshot().lastReadSeq)).toEqual({ personal: 0, total: 0 });

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "event", event: {
      eventId: "member-joined", roomId: "room-1", seq: 5, type: "member.joined",
      actor: { memberId: "member-bob", principalId: "bob" }, createdAt: 5,
      payload: { memberId: "member-bob", displayName: "Bob", role: "participant" },
    } }) });
    expect(client.getSnapshot()).toMatchObject({
      members: [
        { memberId: "member-host", displayName: "Local Host" },
        { memberId: "member-bob", displayName: "Bob" },
      ],
    });

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "event", event: {
      eventId: "member-suspended", roomId: "room-1", seq: 6, type: "member.suspended",
      actor: { memberId: "member-host", principalId: "host" }, createdAt: 6,
      payload: { memberId: "member-bob", status: "suspended" },
    } }) });
    expect(client.getSnapshot().members).toEqual([{ memberId: "member-host", displayName: "Local Host" }]);

    socket?.onmessage?.({ data: JSON.stringify({
      protocol: "dsh-collab.v1", type: "agent-output", roomId: "room-1",
      requestId: "request-3", text: "do not retain", streaming: true,
    }) });
    client.disconnect();
    expect(client.getSnapshot().timeline?.some((item) => item.requestId === "request-3")).toBe(false);
  });

  it("paginates recovery through the authoritative event sequence", async () => {
    const eventCursors: number[] = [];
    let socketUrl = "";
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-room-token",
      });
      if (url.endsWith("/snapshot")) return response({
        room: { roomId: "room-1", title: "Release" },
        members: [{ memberId: "member-host", role: "host" }],
        lastEventSeq: 1_001,
      });
      const after = Number(new URL(url).searchParams.get("after"));
      eventCursors.push(after);
      const end = Math.min(after + 500, 1_001);
      const events = Array.from({ length: end - after }, (_, offset) => {
        const seq = after + offset + 1;
        return { eventId: `event-${String(seq)}`, roomId: "room-1", seq, type: "human.message", actor: { memberId: "member-host", principalId: "host" }, createdAt: seq, payload: { text: String(seq) } };
      });
      return response({ events, nextSeq: end });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(url: string) { socketUrl = url; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });

    await client.bootstrap();

    expect(eventCursors).toEqual([0, 500, 1_000]);
    expect(client.getSnapshot().timeline).toHaveLength(1_001);
    expect(new URL(socketUrl).searchParams.get("after")).toBe("1001");
    client.dispose();
  });

  it("rebuilds recovery from the authoritative server history after a cursor rollback", async () => {
    let generation = 1;
    const socketUrls: string[] = [];
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" },
        member: { memberId: "member-host", role: "host" },
        roomToken: `host-token-${String(generation)}`,
      });
      if (url.endsWith("/snapshot")) return response({
        room: { roomId: "room-1", title: "Release" },
        members: [{ memberId: "member-host", role: "host" }],
        lastEventSeq: generation === 1 ? 1 : 0,
      });
      if (url.endsWith("/workspace-sharing")) return response({ state: generation === 1
        ? { roomId: "room-1", enabled: true, enabledBy: "member-host", enabledAt: 1, revision: 1 }
        : { roomId: "room-1", enabled: false, revision: 0 } });
      if (url.includes("/events?")) return response(generation === 1 ? {
        events: [{
          eventId: "event-old", roomId: "room-1", seq: 1, type: "human.message",
          actor: { memberId: "member-host", principalId: "host" }, createdAt: 1, payload: { text: "old" },
        }],
        nextSeq: 1,
      } : { events: [], nextSeq: 0 });
      if (url.endsWith("/stream-tickets")) return response({ ticket: `ticket-${String(generation)}`, expiresAt: 100 });
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(readonly url: string) { socketUrls.push(url); queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });

    await client.bootstrap();
    await client.getWorkspaceSharing("room-1");
    expect(client.getSnapshot().roomEvents?.map((event) => event.eventId)).toEqual(["event-old"]);
    expect(client.getSnapshot().workspaceSharing).toMatchObject({ enabled: true, revision: 1 });
    generation = 2;
    await client.bootstrap();

    expect(client.getSnapshot().roomEvents).toEqual([]);
    expect(client.getSnapshot().workspaceSharing).toBeUndefined();
    expect(new URL(socketUrls[1]!).searchParams.get("after")).toBe("0");
    client.dispose();
  });

  it("replaces a reused server sequence with its canonical event identity", async () => {
    let generation = 1;
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token",
      });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 1 });
      if (url.includes("/events?")) return response({
        events: [{
          eventId: generation === 1 ? "event-old" : "event-new", roomId: "room-1", seq: 1, type: "human.message",
          actor: { memberId: "member-host", principalId: "host" }, createdAt: generation, payload: { text: generation === 1 ? "old" : "new" },
        }],
        nextSeq: 1,
      });
      if (url.endsWith("/stream-tickets")) return response({ ticket: "ticket", expiresAt: 100 });
      throw new Error(`unexpected request: ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });

    await client.bootstrap();
    generation = 2;
    await client.bootstrap();

    expect(client.getSnapshot().roomEvents?.map((event) => event.eventId)).toEqual(["event-new"]);
    expect(client.getSnapshot().timeline).toEqual([expect.objectContaining({ text: "new" })]);
    client.dispose();
  });

  it("rejects an HTTP recovery page that skips the next event sequence", async () => {
    let socketCount = 0;
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-room-token",
      });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 2 });
      return response({ events: [
        { eventId: "event-2", roomId: "room-1", seq: 2, type: "human.message", actor: { memberId: "member-host", principalId: "host" }, createdAt: 2, payload: { text: "gap" } },
      ], nextSeq: 2 });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { socketCount += 1; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });

    await expect(client.bootstrap()).rejects.toThrow("sequence");
    expect(socketCount).toBe(0);
    client.dispose();
  });

  it("rejects an HTTP recovery cursor that disagrees with its last event", async () => {
    let socketCount = 0;
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-room-token",
      });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 1 });
      return response({ events: [
        { eventId: "event-1", roomId: "room-1", seq: 1, type: "human.message", actor: { memberId: "member-host", principalId: "host" }, createdAt: 1, payload: { text: "first" } },
      ], nextSeq: 2 });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { socketCount += 1; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });

    await expect(client.bootstrap()).rejects.toThrow("sequence");
    expect(socketCount).toBe(0);
    client.dispose();
  });

  it("does not advance the live cursor across a missing event", async () => {
    let socket: BrowserSocket | undefined;
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-room-token",
      });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-1", title: "Release" }, members: [], lastEventSeq: 1 });
      return response({ events: [
        { eventId: "event-1", roomId: "room-1", seq: 1, type: "human.message", actor: { memberId: "member-host", principalId: "host" }, createdAt: 1, payload: { text: "first" } },
      ], nextSeq: 1 });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; this.onclose?.(); }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "event", event: {
      eventId: "event-3", roomId: "room-1", seq: 3, type: "human.message",
      actor: { memberId: "member-host", principalId: "host" }, createdAt: 3, payload: { text: "must wait" },
    } }) });

    expect(client.getSnapshot().timeline).toMatchObject([{ text: "first" }]);
    expect(client.getSnapshot().connection).toBe("offline");
    client.dispose();
  });

  it("persists join credentials in the Participant DSH and resumes without reusing the invite", async () => {
    let persisted: ParticipantResumeState | undefined;
    const urls: string[] = [];
    const fetch: BrowserFetch = async (url) => {
      urls.push(url);
      if (url.endsWith("/join")) return response({
        room: { roomId: "room-2", title: "Remote" },
        member: { memberId: "member-bob", role: "participant" },
        roomToken: "room-token-1",
        resumeCredential: "resume-secret",
      }, 201);
      if (url.endsWith("/resume")) return response({
        room: { roomId: "room-2", title: "Remote" },
        member: { memberId: "member-bob", role: "participant" },
        roomToken: "room-token-2",
      });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 });
      return response({ events: [], nextSeq: 0 });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const persistence = {
      load: () => persisted,
      save: async (state: ParticipantResumeState) => { persisted = state; },
      clear: async () => { persisted = undefined; },
    };
    const invitation = JSON.stringify({ protocol: "dsh-collab.invitation.v2", type: "invite", gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", inviteId: "invite-1", token: "invite-token", expiresAt: 100, network: { mode: "custom-wss", version: 1, endpoint: "wss://collab.example/collab" } });
    const first = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket, participantPersistence: persistence });
    await first.join({ invitation, memberId: "member-bob", displayName: "Bob" });
    expect(persisted).toEqual({ gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret", roomTitle: "Remote" });
    first.dispose();

    const second = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket, participantPersistence: persistence });
    await expect(second.restoreParticipant()).resolves.toBe(true);
    expect(second.getSnapshot()).toMatchObject({ roomId: "room-2", role: "participant", connection: "online" });
    expect(urls.filter((url) => url.endsWith("/join"))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith("/resume"))).toHaveLength(1);
  });

  it("resumes a live Participant after the Host Gateway restarts", async () => {
    vi.useFakeTimers();
    try {
      const persisted: ParticipantResumeState = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };
      const sockets: BrowserSocket[] = [];
      let resumeRequests = 0;
      const fetch: BrowserFetch = async (url) => {
        if (url.endsWith("/resume")) {
          resumeRequests += 1;
          if (resumeRequests === 2) throw new Error("Host Gateway is offline");
          return response({
            room: { roomId: "room-2", title: "Remote" },
            member: { memberId: "member-bob", role: "participant" },
            roomToken: `room-token-${String(resumeRequests)}`,
          });
        }
        if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 });
        return response({ events: [], nextSeq: 0 });
      };
      const WebSocket = class implements BrowserSocket {
        readyState = 1;
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        onclose?: () => void;
        onerror?: () => void;
        constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
        send(): void {}
        close(): void { this.readyState = 3; }
      };
      const client = createDshBrowserCollabClient({
        gatewayUrl: "http://127.0.0.1:4310/collab",
        roomId: "dsh-room",
        fetch,
        WebSocket,
        participantPersistence: { load: () => persisted, save: async () => {}, clear: async () => {} },
      });

      await expect(client.restoreParticipant()).resolves.toBe(true);
      expect(client.getSnapshot().connection).toBe("online");
      sockets[0]?.onclose?.();
      expect(client.getSnapshot().connection).toBe("offline");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(resumeRequests).toBe(2);
      expect(sockets).toHaveLength(1);
      expect(client.getSnapshot().connection).toBe("offline");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(resumeRequests).toBe(3);
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().connection).toBe("online");
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects the explicitly selected Joined room instead of the first saved room", async () => {
    vi.useFakeTimers();
    try {
      const first: ParticipantResumeState = { gatewayEndpoint: "wss://first.example/collab", roomId: "room-first", memberId: "member-bob", credential: "first-secret" };
      const second: ParticipantResumeState = { gatewayEndpoint: "wss://second.example/collab", roomId: "room-second", memberId: "member-bob", credential: "second-secret" };
      const loaded: Array<{ gatewayEndpoint: string; roomId: string } | undefined> = [];
      const sockets: BrowserSocket[] = [];
      const fetch: BrowserFetch = async (url) => {
        const roomId = url.includes("second.example") ? "room-second" : "room-first";
        if (url.endsWith("/resume")) return response({ room: { roomId, title: roomId }, member: { memberId: "member-bob", role: "participant" }, roomToken: `${roomId}-token` });
        if (url.endsWith("/snapshot")) return response({ room: { roomId, title: roomId }, members: [], lastEventSeq: 0 });
        return response({ events: [], nextSeq: 0 });
      };
      const WebSocket = class implements BrowserSocket {
        readyState = 1;
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        onclose?: () => void;
        onerror?: () => void;
        constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
        send(): void {}
        close(): void { this.readyState = 3; }
      };
      const client = createDshBrowserCollabClient({
        gatewayUrl: "http://127.0.0.1:4310/collab",
        roomId: "dsh-room",
        fetch,
        WebSocket,
        participantPersistence: {
          load: (ref) => {
            loaded.push(ref);
            if (!ref) return first;
            return [first, second].find((room) => room.gatewayEndpoint === ref.gatewayEndpoint && room.roomId === ref.roomId);
          },
          save: async () => {},
          clear: async () => {},
        },
      });

      await client.connectJoinedRoom({ gatewayEndpoint: second.gatewayEndpoint, roomId: second.roomId });
      sockets[0]?.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(client.getSnapshot()).toMatchObject({ roomId: "room-second", connection: "online" });
      expect(loaded).toEqual([
        { gatewayEndpoint: second.gatewayEndpoint, roomId: second.roomId },
        { gatewayEndpoint: second.gatewayEndpoint, roomId: second.roomId },
        { gatewayEndpoint: second.gatewayEndpoint, roomId: second.roomId },
      ]);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebootstraps a Host stream after it disconnects", async () => {
    vi.useFakeTimers();
    try {
      let persisted: ParticipantResumeState | undefined = { gatewayEndpoint: "wss://old.example/collab", roomId: "room-old", memberId: "member-old", credential: "old-secret" };
      const sockets: BrowserSocket[] = [];
      let bootstrapRequests = 0;
      const fetch: BrowserFetch = async (url) => {
        if (url.endsWith("/bootstrap")) {
          bootstrapRequests += 1;
          return response({
            room: { roomId: "room-1", title: "Local" },
            member: { memberId: "member-host", role: "host" },
            roomToken: `host-token-${String(bootstrapRequests)}`,
          });
        }
        if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-1", title: "Local" }, members: [], lastEventSeq: 0 });
        return response({ events: [], nextSeq: 0 });
      };
      const WebSocket = class implements BrowserSocket {
        readyState = 1;
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        onclose?: () => void;
        onerror?: () => void;
        constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
        send(): void {}
        close(): void { this.readyState = 3; }
      };
      const client = createDshBrowserCollabClient({
        gatewayUrl: "http://127.0.0.1:4310/collab",
        roomId: "room-1",
        fetch,
        WebSocket,
        participantPersistence: { load: () => persisted, save: async () => {}, clear: async () => { persisted = undefined; } },
      });

      await client.bootstrap();
      sockets[0]?.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(persisted).toMatchObject({ roomId: "room-old", credential: "old-secret" });
      expect(bootstrapRequests).toBe(2);
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot()).toMatchObject({ role: "host", connection: "online" });
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a silent Participant stream when heartbeat responses stop", async () => {
    vi.useFakeTimers();
    try {
      const persisted: ParticipantResumeState = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };
      const sockets: BrowserSocket[] = [];
      const sent: string[] = [];
      let resumeRequests = 0;
      const fetch: BrowserFetch = async (url) => {
        if (url.endsWith("/resume")) {
          resumeRequests += 1;
          return response({
            room: { roomId: "room-2", title: "Remote" },
            member: { memberId: "member-bob", role: "participant" },
            roomToken: `room-token-${String(resumeRequests)}`,
          });
        }
        if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 });
        return response({ events: [], nextSeq: 0 });
      };
      const WebSocket = class implements BrowserSocket {
        readyState = 1;
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        onclose?: () => void;
        onerror?: () => void;
        constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
        send(data: string): void { sent.push(data); }
        close(): void { this.readyState = 2; }
      };
      const client = createDshBrowserCollabClient({
        gatewayUrl: "http://127.0.0.1:4310/collab",
        roomId: "dsh-room",
        fetch,
        WebSocket,
        participantPersistence: { load: () => persisted, save: async () => {}, clear: async () => {} },
      });

      await expect(client.restoreParticipant()).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent.map((frame) => JSON.parse(frame))).toContainEqual({ protocol: "dsh-collab.v1", type: "heartbeat" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.getSnapshot().connection).toBe("offline");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(resumeRequests).toBe(2);
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().connection).toBe("online");
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a rejected resume credential but retains it on a network failure", async () => {
    let persisted: ParticipantResumeState | undefined = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "rejected" };
    const persistence = { load: () => persisted, save: async (state: ParticipantResumeState) => { persisted = state; }, clear: async () => { persisted = undefined; } };
    const rejected = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", participantPersistence: persistence,
      fetch: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: { message: "invalid" } }) }),
      WebSocket: class {} as never,
    });
    await expect(rejected.restoreParticipant()).rejects.toThrow();
    expect(persisted).toBeUndefined();

    persisted = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "offline" };
    const offline = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", participantPersistence: persistence,
      fetch: async () => { throw new Error("network offline"); }, WebSocket: class {} as never,
    });
    await expect(offline.restoreParticipant()).rejects.toMatchObject({ code: "GATEWAY_UNREACHABLE" });
    expect(persisted?.credential).toBe("offline");
  });

  it("distinguishes a stopped Host share, an unreachable Gateway, and a connection limit", async () => {
    const saved: ParticipantResumeState = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret", roomTitle: "Remote" };
    const persistence = { load: () => saved, save: async () => {} };
    const stopped = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", participantPersistence: persistence,
      fetch: async () => errorResponse("ROOM_INACTIVE", "room is not currently shared", 409), WebSocket: class {} as never,
    });
    await expect(stopped.restoreParticipant()).rejects.toMatchObject({ status: 409, code: "ROOM_INACTIVE" });
    expect(stopped.getSnapshot()).toMatchObject({ roomId: "room-2", unavailableReason: "host-stopped-sharing" });

    const limited = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", participantPersistence: persistence,
      fetch: async () => errorResponse("RESOURCE_LIMIT", "connection limit reached", 429), WebSocket: class {} as never,
    });
    await expect(limited.restoreParticipant()).rejects.toMatchObject({ status: 429, code: "RESOURCE_LIMIT" });
    expect(limited.getSnapshot()).toMatchObject({ roomId: "room-2", unavailableReason: "resource-limited" });

    const unreachable = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", participantPersistence: persistence,
      fetch: async () => { throw new TypeError("Failed to fetch"); }, WebSocket: class {} as never,
    });
    await expect(unreachable.restoreParticipant()).rejects.toMatchObject({ code: "GATEWAY_UNREACHABLE" });
    expect(unreachable.getSnapshot()).toMatchObject({ roomId: "room-2", unavailableReason: "host-unreachable" });
  });

  it("marks a connected Participant room as stopped when the Host closes its stream", async () => {
    let socket: BrowserSocket | undefined;
    const saved: ParticipantResumeState = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret", roomTitle: "Remote" };
    const fetch: BrowserFetch = async (url) => url.endsWith("/resume")
      ? response({ room: { roomId: "room-2", title: "Remote" }, member: { memberId: "member-bob", role: "participant" }, roomToken: "room-token" })
      : response({ room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 });
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", participantPersistence: { load: () => saved, save: async () => {} }, fetch, WebSocket });
    await client.restoreParticipant();

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "closed", connectionId: "connection-1", reason: "room_not_shared" }) });

    expect(client.getSnapshot()).toMatchObject({ unavailableReason: "host-stopped-sharing" });
    client.dispose();
  });
});
