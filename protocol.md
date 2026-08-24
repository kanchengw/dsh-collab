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

## HTTP requests

Every request uses:

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
| `POST` | `/collab/v1/rooms/:roomId/invites` | Host creates an invite |
| `POST` | `/collab/v1/rooms/:roomId/join` | Participant accepts an invite |
| `GET` | `/collab/v1/rooms/:roomId/snapshot` | Read the authorized room snapshot |
| `GET` | `/collab/v1/rooms/:roomId/events?after=&limit=` | Read events after an exclusive cursor |
| `POST` | `/collab/v1/rooms/:roomId/messages` | Create a human message or AgentRequest |

`actions` is reserved for the later explicit steer, cancel, member-management
and approval action contract. It is not silently accepted by v1.

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
- `409`: idempotency, invite, or event conflict;
- `422`: invalid input or unsupported protocol data;
- `429`: resource limit (reserved for the production hardening phase);
- `503`: Host or Agent unavailable (must not claim the request was queued).

## Stream frames

The stream is opened at:

```text
GET /collab/v1/rooms/:roomId/stream?after=<exclusive-event-seq>
Authorization: Bearer <room-token>
```

Each JSON server frame has `protocol: "dsh-collab.v1"` and one of these types:

```json
{
  "protocol": "dsh-collab.v1",
  "type": "connected",
  "connectionId": "conn-1",
  "roomId": "room-1",
  "lastEventSeq": 4
}
```

```json
{
  "protocol": "dsh-collab.v1",
  "type": "event",
  "event": { "eventId": "...", "roomId": "room-1", "seq": 5, "type": "human.message", "actor": { "memberId": "...", "principalId": "..." }, "createdAt": 1720000000000, "payload": {} }
}
```

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

## Compatibility rules

- v1 additions must be optional fields or new event payload fields.
- A required field, enum removal, or changed meaning requires a new protocol
  version and an explicit adapter negotiation decision.
- The wire protocol never carries a local Agent handle, DSH connection ID,
  filesystem path, credential, tool argument, or approval secret.
