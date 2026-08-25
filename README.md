# dsh-collab

`dsh-collab` is one installable package for human collaboration around one Host-side DSH Agent session. The same package has a Host face and a Participant face; a room's trusted local-session/token evidence selects the role. A Participant never creates a local Agent or accesses the Host workspace.

## What is ready

- Versioned room protocol, HTTP Gateway, WebSocket stream, invite/join, permissions, message targeting, single Host Agent queue, steer/cancel, approval, limits, revocation, audit redaction, snapshot recovery and observability.
- One package manifest with `exports["./client"]`, `dsh.client`, `dsh.bundle.patch` and `cordis.patch.yml`.
- Structural DSH Host adapter (`src/dsh-host.ts`) and reusable Host runtime factory (`src/host-runtime.ts`). The runtime owns a dedicated Collab-only HTTP/WebSocket listener and uses a structural DSH session service; it does not expose the DSH listener or import DSH private dispatcher code.
- Unified room UI (`src/session-ui.ts`) with Host/Participant identity, connection states, responsive room/timeline/member layout, explicit message target selection and keyboard-friendly native form controls.
- Namespaced settings UI (`src/settings.ts`) controls the dedicated Host Gateway bind mode, port, invitation address and room safety, with loopback defaults and a trusted-network warning. Participants get their remote endpoint from the invitation instead of persistent configuration.
- Host runtime settings now apply token lifetime, member/message/queue limits and approval policy; runtime snapshots restore room, ledger, dispatcher and approval state while short-lived invites and room tokens are reissued after restart.

## Important deployment decision

The plugin does **not** download, install, or start nginx. The plugin owns a
dedicated Collab Gateway, room authorization, HTTP/WebSocket routes, and DSH
UI. A trusted LAN/VPN deployment connects directly to that Gateway and does
not require a reverse proxy.

The checked-in nginx files under `e2e/nginx` are for local two-DSH development
and acceptance only. They do not describe a one-click end-user installation.
An optional managed local proxy would be a separate future feature and must
include signed binaries, upgrades, lifecycle handling, and an explicit
security consent flow.

## Gateway boundary

The in-process Collab Gateway is the application service owned by this package. It listens on its own configured host/port, serves only `/collab`, authenticates invite and room tokens, enforces room permissions, manages approvals, appends the event ledger and queues the one Host Agent. It never serves the DSH UI or general DSH APIs.

A reverse proxy/tunnel is optional and user-supplied only when the Host wants an external `wss://` endpoint. It terminates TLS and forwards HTTP plus WebSocket upgrades to the dedicated Gateway. It is not needed for the LAN MVP, is not a replacement for the Collab Gateway, and is not provisioned by this package.

Participant identity is first bound by possession of a valid one-time invite; subsequent requests use the issued room token. Optional trusted-proxy identity headers remain a deployment extension, but direct clients cannot self-assert them.

## Commands

```sh
pnpm install
pnpm test                 # full unit + integration regression, including local E2E
pnpm vitest run tests/integration/e2e-local.test.ts
pnpm typecheck
pnpm build
pnpm pack --dry-run
pnpm audit --audit-level=high
```

## Local E2E flow

`tests/integration/e2e-local.test.ts` starts a real TCP HTTP server and WebSocket upgrade server on an OS-assigned loopback port. It then:

1. Creates one Host room bound to `session-1`.
2. Creates two invites and joins two Participant identities.
3. Connects two independent WebSocket clients to the same room.
4. Sends a People message and asserts both clients receive the same ledger event.
5. Sends one explicit `dsh` message, automatically dispatches it to the one Host Agent, records the Host followup and fans out an Agent output event.
6. Disconnects and reconnects one Participant, then verifies cursor-based event recovery.

This is the repeatable endpoint for development on one machine; two physical hosts are not required. The test uses the same Gateway, token store, stream upgrade and Host adapter used by the eventual DSH composition. It is not a claim that Chrome DevTools or the complete DSH React shell has already been browser-verified; that requires a configured DSH profile/browser test environment.

## DSH package shape

The bundle patch contains one row:

```yaml
- insert:
    - id: collab-host
      name: dsh-collab
      inject: [agents, settings]
      config:
        enabled: true
        roomId: dsh-room
        hostId: local-host
```

The package's `dsh.client` declaration supplies the browser face. A DSH profile can install the package with its normal plugin command after `pnpm build`; the Host runtime is created through the public adapter seam (`createDshCollabHostRuntime`) and can be mounted by a profile-specific Host integration that supplies the trusted session service and room/session facts. No separate participant-only package is used.

The Host row registers the formal `dsh-collab` settings namespace. Gateway host, port, exposure mode and advertised invitation endpoint are stored as one atomic object through DSH `ctx.settings`; invite tokens and member join fields remain ephemeral UI state and are never persisted as plugin configuration. These Gateway settings apply after a DSH restart.

## LAN Participant deployment

Do not expose the DSH listener. In network mode the dedicated Collab Gateway binds `0.0.0.0` on its own port; the invitation advertises a reachable private IP using `ws://<private-ip>:<port>/collab`. The Participant installs the same complete plugin and pastes the invitation. Possession of its one-time token establishes the initial Participant identity; that room never calls the Participant's local Agent.

Plain `ws://` accepts only literal loopback, RFC1918/link-local, `100.64.0.0/10`, ULA and IPv6 link-local addresses. Public IPs and hostnames require a user-supplied `wss://` endpoint. The plugin does not create a tunnel, configure a router, issue a certificate, or operate an official Relay in this MVP.

The current automated `tests/integration/e2e-local.test.ts` exercises this dedicated listener directly with two Participant clients. Complete two-DSH browser instructions will replace the old nginx development fixture when the settings and invitation UI are connected.

## Design and development log

- Architecture, slot/service/patch boundaries, role model, UI states and phased plan: [design.md](./design.md)
- Unit-by-unit implementation records and commits: [dev_log.md](./dev_log.md)
- HTTP/WebSocket wire contract: [protocol.md](./protocol.md)
