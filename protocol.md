# dsh-collab wire protocol v1

This document defines the transport contract owned by `dsh-collab`. It is
independent of the DSH native Agent or Session protocol.

## Version and mounting

- The JSON field `protocol` is always `dsh-collab.v1`.
- The public plugin mount is `/collab/v1`.
- The current in-memory gateway keeps the shorter `/v1` route contract. A real
  adapter strips `/collab` before delegating to that gateway; clients must use
  the public mount and must not depend on this implementation detail.
- HTTP status remains authoritative for transport behavior. The JSON envelope
  gives clients a stable request correlation and error shape.

## Shareable invitation

The Host shares one JSON invitation. The Participant pastes that invitation
into the same complete `dsh-collab` plugin; no separate Gateway URL setup is
required:

```json
{
  "protocol": "dsh-collab.v1",
  "type": "invite",
  "gatewayEndpoint": "ws://192.168.1.20:4310/collab",
  "roomId": "room-1",
  "inviteId": "invite-1",
  "token": "opaque-invite-secret",
  "expiresAt": 1720000000000
}
```

`gatewayEndpoint` is the canonical stream address. The client derives the
same-origin HTTP API by mapping `ws` to `http` and `wss` to `https`. Plain
`ws://` is accepted only for literal loopback/private addresses; public IPs
and hostnames require `wss://`. Credentials, query strings, fragments,
wildcard bind addresses, and paths other than `/collab` are rejected.

The invitation is a secret because it contains an opaque invite token. It must not
be placed in a URL, browser history, access log, or analytics event. The
external `wss://` endpoint is declarative: v1 does not provision a tunnel,
reverse proxy, public Relay, TLS certificate, or NAT traversal.

## Additive capability negotiation

Post-v1 collaboration mechanisms are gated by additive capability tokens. The
current tokens are `sidecar-review.v1`, `workspace-version.v1`, and
`change-set.v1`. A client declares the capabilities it uses on HTTP requests:

```text
X-DSH-Collab-Capabilities: sidecar-review.v1,workspace-version.v1,change-set.v1
```

and on the existing WebSocket handshake with the repeatable stream feature
parameter:

```text
feature=sidecar-review.v1
```

Unknown capability tokens are ignored. Missing capability declarations retain
the original v1 HTTP surface and server frame set. Capability-gated HTTP routes
must reject invalid declaration shapes or malformed payloads with `422`;
malformed WebSocket declarations or frames cause a protocol error. The server
acknowledges accepted stream capabilities in the optional `capabilities` array
of the initial `connected` frame. Existing clients may ignore that additive
field.

Workspace Snapshot, Review and published SideTask routes require
`sidecar-review.v1`; Workspace Version routes require `workspace-version.v1`;
ChangeSet routes require `change-set.v1`. A capability-gated route behaves as
not found (`404`) when its capability is absent, so an older client retains the
original v1 surface instead of discovering a partial extension.

## HTTP requests

Authenticated room requests use:

```text
X-Request-Id: req_<client-generated-id>
Authorization: Bearer <room-token>
Content-Type: application/json       # requests with a body
```

`X-Request-Id` is a non-blank client correlation ID. Message submission also
has a body-level `clientMessageId`; it is the room-scoped idempotency key and
is intentionally different from the request correlation ID.

For a human room message, the Gateway appends the durable `human.message`
event and waits for critical-state persistence before returning `201`. If that
confirmation fails, an exact retry with the same `clientMessageId` confirms the
existing event without consuming the member message limit or appending another
event. Browser clients retain the unconfirmed ID across network and `5xx`
failures, and release it after success or a deterministic `4xx` rejection.

For an Agent-targeted message, the Gateway creates the deterministic queued
request and its ledger events, then waits for the same critical-state
persistence barrier before returning `202` or allowing Host delivery. A failed
barrier returns `500` and leaves the request non-dispatchable. An exact retry
with the same `clientMessageId`, or a later successful message/Mainline barrier,
confirms the existing whole-runtime state without consuming message/queue limits or
appending duplicate events. Each barrier releases only requests that already
existed when that barrier began, so a concurrent later request cannot be
delivered by an earlier snapshot write. Browser clients apply the same ID
retention rules to human and Agent-targeted messages.

For Host room creation, resume, or rename, the Gateway persists the complete
Owned room metadata before activating sharing or returning `200`. A failed
persistence barrier returns `500` and leaves that room inactive. An exact retry
reconfirms the existing metadata without increasing its revision or creating a
second Host member. Sharing activation remains runtime-only: it is excluded
from Host snapshots, so every new DSH process starts with all Owned rooms not
sharing even though their metadata is restored.

The current routes are:

| Method | Public path | Meaning |
| --- | --- | --- |
| `POST` | `/collab/v1/rooms/:roomId/host` | Authenticated local Host creates, resumes, or renames the exact current DSH session room |
| `POST` | `/collab/v1/rooms/:roomId/invites` | Host creates an invite |
| `POST` | `/collab/v1/rooms/:roomId/join` | Participant accepts an invite |
| `POST` | `/collab/v1/rooms/:roomId/resume` | Participant exchanges a durable resume credential for a new room token |
| `GET` | `/collab/v1/rooms/:roomId/snapshot` | Read the authorized room snapshot |
| `GET` | `/collab/v1/rooms/:roomId/events?after=&limit=` | Read events after an exclusive cursor |
| `POST` | `/collab/v1/rooms/:roomId/messages` | Create a human message or AgentRequest |
| `GET` | `/collab/v1/rooms/:roomId/approvals` | Host lists approval projections |
| `POST` | `/collab/v1/rooms/:roomId/approvals` | Host creates an approval projection |
| `POST` | `/collab/v1/rooms/:roomId/actions` | Host cancels, manages members or decides an approval |
| `GET` | `/collab/v1/rooms/:roomId/workspace-sharing` | Active member reads the runtime-only Workspace Sharing state; requires `sidecar-review.v1` |
| `POST` | `/collab/v1/rooms/:roomId/workspace-sharing` | Host enables or disables Workspace Sharing for this runtime; requires `sidecar-review.v1` |
| `POST` | `/collab/v1/rooms/:roomId/workspace-snapshots` | Active member captures the current immutable Host workspace; requires `sidecar-review.v1` and enabled Workspace Sharing |
| `GET` | `/collab/v1/rooms/:roomId/workspace-snapshots/:snapshotId` | Active member reads one snapshot manifest under the same sharing gate |
| `GET` | `/collab/v1/rooms/:roomId/workspace-snapshots/:snapshotId/files/:fileIndex?offset=&limit=` | Active member reads an authenticated, bounded content chunk; `limit` is at most 262144 bytes |
| `POST` | `/collab/v1/rooms/:roomId/change-sets/uploads` | Host, lead or Participant creates or resumes an idempotent ChangeSet upload; requires `change-set.v1` and enabled Workspace Sharing |
| `POST` | `/collab/v1/rooms/:roomId/change-sets/uploads/:uploadId/chunks` | Uploads the next authenticated patch or result chunk; each chunk is at most 262144 bytes |
| `POST` | `/collab/v1/rooms/:roomId/change-sets/uploads/:uploadId/finalize` | Revalidates the complete artifact and atomically publishes it to the Owner Staging Area |
| `GET` | `/collab/v1/rooms/:roomId/change-sets/reviews?after=&limit=` | Active member reads the authoritative ChangeSet review queue newest-activity first; defaults to 50 and caps at 100 |
| `GET` | `/collab/v1/rooms/:roomId/change-sets/:changeSetId` | Active member reads one immutable staged ChangeSet manifest under the sharing gate |
| `GET` | `/collab/v1/rooms/:roomId/change-sets/:changeSetId/patch?offset=&limit=` | Active member reads the exact staged diff in authenticated bounded chunks |
| `GET` | `/collab/v1/rooms/:roomId/change-sets/:changeSetId/review` | Active member reads the current required-reviewer and Finding counts |
| `PUT` | `/collab/v1/rooms/:roomId/change-sets/:changeSetId/reviewer` | ChangeSet author or Host idempotently assigns one active room member using `{ clientRequestId, reviewerId }` |
| `POST` | `/collab/v1/rooms/:roomId/change-sets/:changeSetId/decisions` | Current required reviewer records the first and only `approved` or `changes-requested` decision |
| `PUT` | `/collab/v1/rooms/:roomId/change-sets/:changeSetId/revision` | New ChangeSet author idempotently links it to one same-author predecessor using `{ clientRequestId, supersedesChangeSetId }` |
| `GET` | `/collab/v1/rooms/:roomId/change-sets/:changeSetId/findings?after=&limit=` | Active member reads immutable Findings newest-first; defaults to 50 and caps at 100 |
| `POST` | `/collab/v1/rooms/:roomId/change-sets/:changeSetId/findings` | Active member creates one idempotent `general`, `file`, or `line` Finding |
| `GET` | `/collab/v1/rooms/:roomId/review-points?after=&limit=` | Active member reads persisted Review Point projections; defaults to 50 and caps at 100 |
| `POST` | `/collab/v1/rooms/:roomId/review-points` | Host captures the current workspace and creates one immutable Review Point |
| `POST` | `/collab/v1/rooms/:roomId/review-points/refresh` | Host captures a new comparison snapshot used for freshness and workspace progress |
| `GET` | `/collab/v1/rooms/:roomId/review-points/:reviewPointId/diffs/:fileIndex` | Active member reads one immutable historical file diff; Workspace Sharing must be enabled |
| `GET` | `/collab/v1/rooms/:roomId/review-points/:reviewPointId/findings?after=&limit=` | Active member reads persisted findings newest-first; defaults to 50 and caps at 100 |
| `POST` | `/collab/v1/rooms/:roomId/review-points/:reviewPointId/findings` | Active member publishes one idempotent general/file/line finding |
| `PUT` | `/collab/v1/rooms/:roomId/review-points/:reviewPointId/reviewers` | Host replaces reviewer assignment metadata with active room members |
| `PUT` | `/collab/v1/rooms/:roomId/review-points/:reviewPointId/lifecycle` | Host advances the Review Point lifecycle |
| `PUT` | `/collab/v1/rooms/:roomId/review-points/:reviewPointId/findings/:findingId/state` | Host accepts or dismisses an open finding |
| `POST` | `/collab/v1/rooms/:roomId/review-points/:reviewPointId/publications` | Active member publishes selected requester-local Review findings as one group |
| `GET` | `/collab/v1/rooms/:roomId/review-points/:reviewPointId/publications` | Active member reads persisted publication groups newest-first |
| `PUT` | `/collab/v1/rooms/:roomId/review-points/:reviewPointId/publications/:publicationId/state` | Host accepts one publication group and idempotently creates its Mainline Integration Task |

ChangeSet upload creation accepts `{ clientRequestId, draft }`.
`clientRequestId` is namespaced by the authenticated room member. An exact
retry resumes the same upload after a lost response or process restart; the
same key with another valid content identity returns `REQUEST_CONFLICT`.
The draft author must be that authenticated member, its base Workspace Version
must already belong to the room, and its serialized manifest is capped at
768 KiB so the creation request remains under the Gateway's 1 MiB body limit.
The response includes the contiguous `patchOffset` and one `resultOffsets`
entry per manifest file, so a newer client with a different chunk size resumes
from server-confirmed bytes instead of replaying the old segmentation.

Chunk creation accepts exactly
`{ target, fileIndex?, offset, byteLength, chunkHash, data }`, where `target` is
`patch` or `result`, `data` is canonical base64, and `chunkHash` is SHA-256 of
the decoded bytes. Chunks are sequential per artifact, exact chunk retries are
idempotent, and one upload is capped at 4096 chunks. Partial upload directories
are temporary and are never returned by ChangeSet read routes.

Finalize reconstructs every declared result blob, verifies path/hash/size and
the base Workspace Version, then regenerates the deterministic unified diff
from Owner-held base bytes plus the uploaded results. The uploaded patch,
per-file additions/deletions and manifest must exactly match that regenerated
artifact. Only then is one directory renamed into the Owner's local Staging
Area. The default location is `DSH_HOME/collab/v1/change-sets`; it is separate
from the Owner canonical workspace, and U16 exposes no canonical-workspace
write or apply operation. Both Owner and Participant therefore read the same
stored patch. ChangeSet bounds remain 1000 changed files, 2 MiB per text side,
8 MiB aggregate base/result text and 16 MiB patch; binary/non-UTF-8 content is
rejected.

ChangeSet Review assignment is separate from the immutable ChangeSet artifact.
The current review projection contains at most one `requiredReviewerId`, while
every assignment or reassignment remains in append-only Host snapshot history.
Assignment is a queue/reminder hint, not an authorization boundary: all active
room members can read and add Findings. A Finding is permanently anchored to
the exact `changeSetId`; file/line paths must occur in that ChangeSet and line
numbers are positive integers. Exact request retries return the original
assignment/Finding, while reusing an ID with changed content returns `409`.
Mutations append the assignment/Finding to the Host's durable Review snapshot
and wait for critical-state persistence before the Gateway responds. A new
mutation also emits `changeset.review-assigned` or `changeset.finding-created`
as a live `collaboration-event`, only to stream connections that declared
`change-set.v1`. These notifications do not enter the durable RoomEvent stream
or advance its cursor. After reconnecting, clients recover authoritative state
from `GET /change-sets/reviews` and the review/Finding routes. These routes
require the existing `change-set.v1` capability and enabled Workspace Sharing.

Only the current required reviewer may record the first terminal review
decision. Exact retries with the same member-scoped request ID are idempotent;
a second decision is rejected. `approved` means ready for the Owner's later
apply workflow and never means `applied`. After `changes-requested`, the author
may link one new immutable same-author ChangeSet as the direct revision. The
old Review and Findings remain anchored to their original ChangeSet; the queue
projects the predecessor as `superseded`. Decision and revision mutations use
the same persistence barrier and emit `changeset.review-decided` or
`changeset.revision-linked` live notifications.

Apply preflight is currently a Host-domain contract rather than a public HTTP
route. Only the active Owner member can invoke it. Its canonical-workspace port
is read-only and returns only path hash/size inspection, so U20 cannot write,
remove, or rename Owner files. Preflight validates the complete staged envelope,
safe paths, approved decision and every result blob before returning either one
fully verified in-memory plan or one conflict containing all stale touched
paths. Add and rename operations also require an absent target. Artifact
corruption fails closed and is not mislabeled as a workspace conflict.

Conflict records use deterministic IDs, are append-only in the apply-preflight
service snapshot, and exact retries do not emit duplicates. They do not enter
the v1 RoomEvent cursor. The public apply route, integration lock, persistence
barrier, journal, file replacement, applied state and next Workspace Version
remain U21/U22 work; therefore `approved` still never implies `applied` in U20.

The `host` request is authenticated by the local Gateway boundary rather than
an existing room token. Its body is `{ "hostSessionId": "...", "title": "..." }`;
`roomId` must equal `hostSessionId`, the title is trimmed and limited to 80
characters, and the Host session service must prove that the current DSH
runtime owns that session. A successful response issues the Host's initial room
token. `join` authenticates with the one-hour invitation, which may be used by
multiple members, and accepts an optional
client-generated `resumeCredential`, while `resume` authenticates with that
durable Participant credential.

A successful `join` response includes both a short-lived `roomToken` and a
durable `resumeCredential`. Current clients generate a cryptographically random
credential, save the provisional room/member binding on the Participant's own
DSH host, and include it in the Join body before sending the request:

```json
{
  "inviteId": "invite-1",
  "token": "opaque-invite-token",
  "memberId": "member-1",
  "displayName": "Alice",
  "resumeCredential": "opaque-participant-resume-secret"
}
```

The room owner stores only the credential's SHA-256 digest. The same invitation
may be accepted by multiple distinct member bindings while it remains valid. The
same member binding, display name and resume credential may be retried exactly
when a response or persistence acknowledgement is lost; it returns the existing
member without adding another member, event or credential. The Gateway waits for
its configured critical-state persistence barrier after the member, credential
digest and joined event mutations before returning success. Older clients may omit
`resumeCredential`; the Gateway continues to issue one for compatibility. A later
resume request uses this body:

```json
{ "credential": "opaque-participant-resume-secret" }
```

The Gateway validates the durable room/member binding and returns a fresh
short-lived `roomToken`. The Participant stores the raw credential in its own
DSH's hidden `dsh-collab-participant` settings namespace, not browser storage
or the Host configuration namespace. Suspending or removing the member
invalidates all of that member's resume credentials.

Event pages are cursor-continuous. A non-empty response starts at `after + 1`,
contains consecutive `seq` values, and sets `nextSeq` to the last returned
event. A client recovering a snapshot must reach at least the snapshot's
`lastEventSeq` before opening the stream and must reject a skipped sequence or
a disagreeing `nextSeq`. A page may advance beyond the snapshot cursor when a
new event is appended concurrently; those events remain valid only when the
sequence is continuous.

The current implementation exposes the following explicit v1 actions:

```json
{ "action": "cancel", "requestId": "request-1", "keepInbox": true }
```

Cancellation writes the request terminal state and its single
`agent.request.cancelled` event, then waits for critical-state persistence
before returning `200`. A persistence failure returns `500`; retrying the same
request confirms the existing cancelled state without cancelling the Host
Agent or appending the event again. With `keepInbox=false`, the same barrier
also covers all same-room queued requests cancelled by that action.

```json
{ "action": "setMemberStatus", "memberId": "member-2", "status": "suspended" }
```

Member status and role actions mutate durable authorization state. The Gateway
applies the room member change, credential revocation and single audit event,
then waits for its configured critical-state persistence barrier before returning
success. A persistence failure returns `500`; retrying the same resulting status
or role waits for persistence again without appending a duplicate event.

```json
{ "action": "setMemberRole", "memberId": "member-2", "role": "lead" }
```

```json
{ "action": "decideApproval", "approvalId": "approval-1", "outcome": "allowed-once" }
```

Approval requests are created and listed at `/collab/v1/rooms/:roomId/approvals`.
Approval creation and decisions append their idempotent event and wait for the
same critical-state persistence barrier before returning `201` or `200`.
Retrying an identical `approvalId` request or decision after a `500` returns
the existing state without a second requested/decided event; a conflicting
payload or outcome remains rejected.
All actions are authorized from the room token principal; body-level actor
fields are ignored because they are not part of the contract.

Workspace Sharing updates accept only `{ "enabled": true | false }`. The
Gateway derives the actor from the verified room token and current RoomStore
membership; body-level actor fields have no effect. Only the current Host may
change the state, while any active member may read it. The state defaults to
disabled, is not included in Host snapshots, and resets to disabled when room
sharing stops or the Host runtime restarts. A later workspace read while the
switch is off returns `409 WORKSPACE_SHARING_DISABLED`.

Snapshot capture accepts `{ "clientRequestId": "..." }`. The Gateway derives a
stable snapshot ID from the verified room principal, the resource purpose and
that request ID, so a retry of the same command after a lost response or Host
restart returns the same immutable artifact instead of capturing a second
version. Ordinary snapshot capture, Review Point creation and comparison refresh use
separate purpose namespaces, so reusing a request ID across resources cannot
reuse the wrong artifact. The client cannot supply a workspace
path, Host Session ID, file path, or snapshot ID. A manifest contains only
repository-relative paths, content hashes, byte sizes and snapshot metadata;
content is fetched by numeric `fileIndex` so untrusted paths never enter the
HTTP route.

Each chunk response includes `snapshotId`, `fileIndex`, `offset`, `byteLength`,
`chunkHash`, base64 `data` and `eof`. Clients validate every chunk and the final
file hash before atomically publishing a local read-only workspace. Capture is
bounded to 10,000 files, 64 MiB per file and 256 MiB total; Participant download
is independently bounded to 10,000 files and 256 MiB total. Disabling Workspace
Sharing rejects every new manifest or chunk request, but already materialized
local content remains readable without the Host.

Review Point creation accepts `{ clientRequestId, title, focus?, files }`.
`clientRequestId` is at most 128 characters and makes creation idempotent across
lost responses and Host restarts. `files` is the Host UI's current changed-file
projection and contains `{ path, previousPath?, status, additions, deletions }`;
the server copies content hashes from the snapshot it captures and rejects
non-deleted paths that are absent from that snapshot. `previousPath` is present
for a rename so the server can read the exact base blob from the pinned `HEAD`.
At creation time the Host persists an immutable per-file artifact made from
`HEAD` old text and the captured Workspace Snapshot new text. Text is limited to
2 MiB per side and 8 MiB per Review Point; binary or larger files persist an
explicit non-text marker. Both clients therefore read the same historical diff
after the live workspace changes. Line statistics remain descriptive Host UI
metadata and are not the authoritative diff. A Review Point requires a Git
`HEAD`; an unborn repository is rejected rather than inventing a commit identity.
Review Points restored from the pre-artifact U08 snapshot format expose an
explicit `unavailable` diff marker instead of failing as if the node did not
exist; newly persisted Review Point snapshots require one artifact per file.

The list response is `{ reviewPoints, nextCursor? }`, where each item contains
the immutable `reviewPoint` plus three independent projections:

- `lifecycle` remains part of the Review Point and starts as `open`;
- `freshness` is exactly `current` or `stale`, based only on hashes for paths in
  `reviewPoint.files`;
- `progress` contains the live `roomEventDelta` and the number of paths whose
  hashes differ between the Review Point snapshot and the latest Host comparison
  snapshot.

Changing only chat history or a non-reviewed file never creates a third
freshness state. It updates progress while freshness remains `current`. Refresh
accepts `{ clientRequestId }`; it is Host-only because it captures the current
Host workspace. Active Participants read the most recently persisted comparison
result and may explicitly reload the list. CM-U08 adds no Review WebSocket frame,
so old clients and the existing durable room cursor remain unchanged.

Review Point creation, refresh, reviewer assignment and lifecycle updates wait
for critical-state persistence before returning success. A persistence failure
returns `500` while retaining the in-process projection. Retrying creation with
the same `clientRequestId` confirms the existing point without capturing a
second artifact; reviewer/lifecycle PUTs re-confirm their already-applied target
state. Browser clients also retain a refresh `clientRequestId` across network or
`5xx` failures, so the deterministic Workspace Snapshot artifact is reused.

Finding creation accepts `{ clientRequestId, severity, location, body }`.
`clientRequestId` is at most 128 characters and is namespaced by verified room
principal, so a lost-response retry returns the original finding. `body` is
trimmed and limited to 4,000 characters. `location` is exactly one of
`{ kind: "general" }`, `{ kind: "file", path }`, or
`{ kind: "line", path, line }`; file and line paths must belong to the original
Review Point and line numbers are positive safe integers. New findings require
an open room and non-closed Review Point. A retry of the same normalized
creation payload for an already-created finding remains idempotent after closure.

A room persists at most 1,000 findings. The limit is checked before mutation and
again during Host snapshot restore; exceeding it returns `RESOURCE_LIMIT` for a
new request and rejects malformed persisted state. This bound protects the
Owner's memory, state file and full-snapshot write path from an active member.

`reviewerIds` is assignment/reminder metadata, not an access list. Any active
room member can publish and read findings; only the Host can assign currently
active members, decide findings, or advance lifecycle. Finding decisions are
one-way `open -> accepted | dismissed`. Lifecycle transitions are one-way:
`open -> changes-requested | approved | closed`,
`changes-requested -> approved | closed`, and `approved -> closed`.
`closed` is terminal. The reserved `resolved` finding state is not produced by
CM-U09 and remains for later re-review/Mainline integration.
New reviewer assignments, lifecycle transitions and finding decisions require
both the room and Review Point to remain writable. Exact retries of an already
applied PUT remain idempotent after either one closes.

Finding creation/decision and SideTask publication wait for critical-state
persistence before returning `201`/`200`. A failed write returns `500` while
retaining the in-process result. Exact retries reuse the existing finding by
`clientRequestId`, the existing decision by target state, or the existing
publication by `taskId` and normalized payload; they do not append duplicate
findings or publications. Mainline acceptance remains a separate Host-only
mutation with its own combined publication/Dispatcher barrier.

Findings remain publishable after Workspace Sharing is disabled because they
contain review metadata rather than a new code read. Reading the historical diff
remains under the room-level Workspace Sharing gate. No Review/finding WebSocket
event is introduced; explicit HTTP reload avoids a second durable cursor and
remains compatible with older clients.

Requester-local Review publication accepts
`{ taskId, workspaceSnapshotId, summary, findings }`. `taskId` is trimmed and
limited to 128 characters. The authenticated room principal, room and task ID
derive the immutable `publicationId`; `publishedBy` is always the current member
derived from the room token. The supplied snapshot must be the Review Point's
fixed snapshot. A publication contains 1–100 findings, every finding uses the
same validated severity/location/body contract as a Human finding, and summary
plus finding bodies are limited to 8,000 characters. Together with the existing
1,000 findings-per-room bound, this also bounds the unpaginated publication list
to at most 1,000 entries.

Retrying the same normalized publication returns the existing group; changing
its summary, selection, order or finding content returns `REQUEST_CONFLICT`.
Publication succeeds while Workspace Sharing is disabled, provided the room and
Review Point remain open. A requester whose remote publication succeeded before
its local DSH persisted the linkage may list publications and recover the exact
group by authenticated member and local task ID.

Publication state is `published -> accepted`. The state endpoint accepts only
`{ "state": "accepted" }` and only the Host may call it. Acceptance is atomic for
all findings in the group; publication-owned findings cannot be decided
individually while the group is pending. Acceptance derives a stable
`integrationRequestId` from room and publication, submits exactly one request to
the existing Main Agent queue, and remains idempotent across retries and Host
restart. The Mainline request treats Review content as untrusted data, identifies
the historical Review Point/snapshot, and requires the Main Agent to inspect and
reimplement against current Host code rather than applying a Sidecar patch.

New Mainline Integration Tasks use the reserved
`internal:mainline:<64 lowercase hex>` request-ID namespace. External messages
using the legacy raw `messageId` contract cannot claim that namespace. The
Dispatcher must synchronously accept the deterministic request before the
publication and its findings become `accepted`; a queue or request-ID conflict
therefore leaves them `published` and `open`. Exact acceptance retries recreate a
missing request or return the existing identical request without duplication.
With default Host persistence enabled, acceptance waits for an atomically
replaced runtime snapshot that contains both the accepted publication and its
Dispatcher request before delivery starts or success is returned. A persistence
failure returns `500 INTERNAL_ERROR` and does not deliver the request; an exact
retry persists and reuses the same deterministic request. During restoration,
a queued `internal:mainline:` request that is not referenced by an accepted
publication is failed rather than delivered. In-process Mainline requests use
the same non-dispatchable persistence gate as ordinary Agent requests, so no
other queue trigger can deliver a failed or still-pending acceptance.
For upgrade compatibility, Host snapshot restoration and Browser response
decoding continue to accept the former unprefixed 64-lowercase-hex integration
ID, but new acceptance never generates that legacy form.

## HTTP responses

Successful responses use:

```json
{
  "protocol": "dsh-collab.v1",
  "requestId": "req_123",
  "ok": true,
  "data": { "...": "route-specific response" }
}
```

Errors use the same envelope:

```json
{
  "protocol": "dsh-collab.v1",
  "requestId": "req_123",
  "ok": false,
  "error": {
    "code": "ACTION_FORBIDDEN",
    "message": "当前成员没有执行该操作的权限",
    "details": { "action": "steer" }
  }
}
```

An adapter must not expose a native DSH connection error or stack trace. The
stable status mapping is:

- `401`: missing or invalid authentication;
- `403`: authenticated but outside room/action scope;
- `404`: route, room, invite, or event not found;
- `409`: idempotency, invite, event, room-activation, or Workspace Sharing state conflict;
- `422`: invalid input or unsupported protocol data;
- `429`: configured message, queue, member, or Workspace Snapshot resource limit;
- `503`: Host or Agent unavailable (must not claim the request was queued).

## Stream frames

The stream is opened at the fixed exact pathname below. `roomId` is a query
parameter because the DSH WebServer upgrade registry intentionally accepts
exact paths only; registering one dynamic route per room would leak room
lifecycle into the global route table.

```text
GET /collab/v1/stream?roomId=<room-id>&after=<exclusive-event-seq>&connectionId=<optional-id>&feature=agent-output&feature=sidecar-review.v1
Authorization: Bearer <room-token>
```

Each JSON server frame has `protocol: "dsh-collab.v1"` and one of these types:

```json
{
  "protocol": "dsh-collab.v1",
  "type": "connected",
  "connectionId": "conn-1",
  "roomId": "room-1",
  "lastEventSeq": 4,
  "capabilities": ["sidecar-review.v1"]
}
```

```json
{
  "protocol": "dsh-collab.v1",
  "type": "event",
  "event": { "eventId": "...", "roomId": "room-1", "seq": 5, "type": "human.message", "actor": { "memberId": "...", "principalId": "..." }, "createdAt": 1720000000000, "payload": {} }
}
```

Clients opt in to active Agent text with the repeatable `feature=agent-output`
query parameter. Without that feature the Host sends only the original v1
frames, so older clients continue to receive the durable final result. An
opted-in client receives accumulated, transient snapshots:

```json
{
  "protocol": "dsh-collab.v1",
  "type": "agent-output",
  "roomId": "room-1",
  "requestId": "request-1",
  "text": "partial answer",
  "streaming": true
}
```

`agent-output` is not assigned an event sequence and is not written to the
room ledger. A later snapshot for the same request replaces the earlier text.
Only `streaming: true` output is retained for a later connection. A
`streaming: false` frame or durable `agent.state.changed`,
`agent.request.completed`, `agent.request.failed`, `agent.request.rejected`, or
`agent.request.cancelled` event ends the transient projection; durable events
remain the authoritative history. A connection opened during generation
receives the latest accumulated snapshot after complete normal event replay.

Clients that declare `sidecar-review.v1` may also receive collaboration event
frames. The first additive event reports the runtime-only Workspace Sharing
state used by the next implementation Unit:

```json
{
  "protocol": "dsh-collab.v1",
  "type": "collaboration-event",
  "event": {
    "type": "workspace-sharing.changed",
    "state": {
      "roomId": "room-1",
      "enabled": true,
      "enabledBy": "member-host",
      "enabledAt": 1720000000000,
      "revision": 1
    }
  }
}
```

When `enabled` is `false`, `enabledBy` and `enabledAt` are omitted. This event
is a live projection and does not advance the durable room event cursor. A
client reconnects by reading the authoritative Workspace Sharing state from
the capability-gated HTTP API introduced with Workspace Sharing.

Clients that declare `change-set.v1` may receive `changeset.review-assigned`,
`changeset.finding-created`, `changeset.review-decided`, and
`changeset.revision-linked` collaboration events. They are best-effort live
notifications: they do not advance `lastEventSeq` and are not replayed from the
RoomEvent cursor. The persisted Review queue, Review detail, and Finding routes
are the authoritative reconnect path. Connections that did not declare
`change-set.v1` retain the original v1 frame set.

```json
{
  "protocol": "dsh-collab.v1",
  "type": "heartbeat",
  "connectionId": "conn-1",
  "serverTime": 1720000000000
}
```

```json
{
  "protocol": "dsh-collab.v1",
  "type": "closed",
  "connectionId": "conn-1",
  "reason": "member_inactive"
}
```

The client may send only these control frames in v1:

```json
{ "protocol": "dsh-collab.v1", "type": "heartbeat" }
```

```json
{ "protocol": "dsh-collab.v1", "type": "close" }
```

Unknown protocol versions, frame types, negative cursors, and malformed event
actors are rejected. Event `seq` is assigned by the Host ledger; clients
cannot choose or advance it. Reconnection starts with the last confirmed
cursor and uses exclusive replay. The Host replays all remaining ledger pages,
not only the first page. A client ignores an already-seen event ID, but any
other live event must be exactly `lastEventSeq + 1`; a gap closes that stream
without rendering the event and reconnects from the last confirmed cursor.
Transient Agent output never advances that cursor.

## Compatibility rules

- v1 additions must be optional fields or new event payload fields.
- A new server frame must be gated by an explicit client `feature` query;
  clients without that opt-in must retain the previous v1 frame set.
- Unknown additive capabilities are ignored; a known capability never changes
  the meaning of a pre-existing frame or route.
- A required field, enum removal, or changed meaning requires a new protocol
  version and an explicit adapter negotiation decision.
- The wire protocol never carries a local Agent handle, DSH connection ID,
  filesystem path, tool argument, or approval secret. Invite, room and resume
  credentials appear only in their dedicated authentication fields and must
  not be copied into events, logs or URLs.
Agent request lifecycle persistence
-----------------------------------

After an accepted Agent request is queued, the Host persists the `running` claim
before delivering it to the DSH Agent. Agent output and the `completed` or
`failed` terminal event are each persisted before the lifecycle operation is
considered complete. If a persistence barrier fails before delivery, no Agent
side effect is started; if it fails after delivery, the in-memory record remains
the authoritative `running`/terminal projection and recovery treats an active
request with unknown outcome as failed rather than redelivering it.

## Persistence mutation matrix

The following matrix is the release boundary for Host-owned state. A durable
mutation is not reported as successful until the existing whole-runtime
snapshot barrier has observed it. Ephemeral projections are intentionally
recreated or cleared at process boundaries and are not part of the Host
snapshot contract.

| Mutation or state | Durability | Success boundary / restart behavior |
| --- | --- | --- |
| Room creation, Host room binding and title changes | Durable | Room metadata is committed before sharing becomes active; it is restored after restart. |
| Member join, role and status changes | Durable | Member and ledger event are committed before success; token and resume revocation follows the same mutation. |
| Resume credential binding | Durable digest only | The Host stores only the SHA-256 digest and binding; raw credentials and room tokens are reissued or kept on the Participant side. |
| Agent request queued, claimed/running, output, completed/failed/cancelled | Durable | Queue and ledger transitions are barrier-confirmed; an unconfirmed active delivery is failed as outcome-unknown on restart and is never redelivered automatically. |
| Approval request and decision | Durable | Approval projection and ledger event are committed before the HTTP response. |
| ChangeSet reviewer assignment, Finding, decision and revision link | Durable | Append-only review workflow state is captured by the whole-runtime snapshot barrier before the Gateway responds; capability-gated live notifications are not Room Ledger events. |
| Review Point, freshness comparison, reviewers, lifecycle, findings and publication | Durable | Review aggregates and their immutable references are committed before success. Mainline acceptance commits the accepted publication and integration request together. |
| One-time invitation lifecycle | Ephemeral | Invite secrets and active/accepted/expired projections are held in memory; a restart invalidates them. A joined member is durable through the member and ledger commit. |
| Room tokens and resume exchange access tokens | Ephemeral | Tokens are reissued after restart; revocation is enforced in the current process and durable resume records are revoked when applicable. |
| ActiveRoomRegistry, Workspace Sharing, live presence/connections and transient Agent output | Ephemeral | Sharing and live projections are cleared on stop/restart; clients reacquire authoritative state through HTTP and replay durable events. |

No mutation outside the durable rows above may be promoted to a durable
contract merely because it is observable in memory.
