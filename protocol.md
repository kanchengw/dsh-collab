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
  "token": "opaque-one-time-secret",
  "expiresAt": 1720000000000
}
```

`gatewayEndpoint` is the canonical stream address. The client derives the
same-origin HTTP API by mapping `ws` to `http` and `wss` to `https`. Plain
`ws://` is accepted only for literal loopback/private addresses; public IPs
and hostnames require `wss://`. Credentials, query strings, fragments,
wildcard bind addresses, and paths other than `/collab` are rejected.

The invitation is a secret because it contains a one-time token. It must not
be placed in a URL, browser history, access log, or analytics event. The
external `wss://` endpoint is declarative: v1 does not provision a tunnel,
reverse proxy, public Relay, TLS certificate, or NAT traversal.

## Additive capability negotiation

The collaboration mechanisms extension is gated by the exact capability token
`sidecar-review.v1`. A client declares it on HTTP requests with:

```text
X-DSH-Collab-Capabilities: sidecar-review.v1
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

All Workspace, Review and published SideTask HTTP routes added after the base
v1 contract require `sidecar-review.v1`. A capability-gated route behaves as
not found (`404`) when that capability is absent, so an older client retains
the original v1 surface instead of discovering a partial extension.

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

The `host` request is authenticated by the local Gateway boundary rather than
an existing room token. Its body is `{ "hostSessionId": "...", "title": "..." }`;
`roomId` must equal `hostSessionId`, the title is trimmed and limited to 80
characters, and the Host session service must prove that the current DSH
runtime owns that session. A successful response issues the Host's initial room
token. `join` authenticates with the one-time invitation, while `resume`
authenticates with the durable Participant resume credential.

A successful `join` response includes both a short-lived `roomToken` and a
durable `resumeCredential`. The raw resume credential is returned only once
and must be stored on the Participant's own DSH host; the room owner stores
only its SHA-256 digest. A later resume request uses this body:

```json
{ "credential": "opaque-participant-resume-secret" }
```

The Gateway validates the durable room/member binding and returns a fresh
short-lived `roomToken`. The Participant stores the raw credential in its own
DSH's hidden `dsh-collab-participant` settings namespace, not browser storage
or the Host configuration namespace. Suspending or removing the member
invalidates all of that member's resume credentials.

The current implementation exposes the following explicit v1 actions:

```json
{ "action": "cancel", "requestId": "request-1", "keepInbox": true }
```

```json
{ "action": "setMemberStatus", "memberId": "member-2", "status": "suspended" }
```

```json
{ "action": "setMemberRole", "memberId": "member-2", "role": "lead" }
```

```json
{ "action": "decideApproval", "approvalId": "approval-1", "outcome": "allowed-once" }
```

Approval requests are created and listed at `/collab/v1/rooms/:roomId/approvals`.
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
stable snapshot ID from the verified room principal and that request ID, so a
retry after a lost response or Host restart returns the same immutable artifact
instead of capturing a second version. The client cannot supply a workspace
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
The durable `agent.state.changed`, `agent.request.failed`, or
`agent.request.cancelled` event ends the transient projection and remains the
authoritative history. A connection opened during generation receives the
latest accumulated snapshot after normal event replay.

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
cursor and uses exclusive replay, with event ID de-duplication at the client.
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
