# dsh-collab

`dsh-collab` is one installable package for human collaboration around one Host-side DSH Agent session. The same package has a Host face and a Participant face; a room's trusted local-session/token evidence selects the role. A Participant never replaces the room's Host Agent or directly accesses the Host workspace; explicitly started private Side Work uses the Participant's own local DSH Agent.

## What is ready

- Versioned room protocol, HTTP Gateway, WebSocket stream, invite/join, permissions, message targeting, single Host Agent queue, steer/cancel, approval, limits, revocation, audit redaction, snapshot recovery and observability.
- One package manifest with `exports["./client"]`, `dsh.client`, `dsh.bundle.patch` and `cordis.patch.yml`.
- Structural DSH Host adapter (`src/dsh-host.ts`) and reusable Host runtime factory (`src/host-runtime.ts`). The runtime owns a dedicated Collab-only HTTP/WebSocket listener and uses a structural DSH session service; it does not expose the DSH listener or import DSH private dispatcher code.
- Unified room UI (`src/session-ui.ts`) with Host/Participant identity, connection states, responsive room/timeline/member layout, explicit message target selection and keyboard-friendly native form controls.
- Namespaced settings UI (`src/collab-settings-card.tsx`) starts safely as `Not configured` and offers three released connection methods: `EasyTier virtual network`, direct `Private network` access, or a user-supplied `Custom WSS endpoint`. Participants get the selected transport from the invitation instead of persistent endpoint configuration.
- The dedicated Gateway starts independently of DSH conversations and auto-selects the first available port in `4310-4399`, preferring the last persisted port. A room is created only when the Owner uses `Share this session` in a real DSH conversation; its room ID is that exact native session ID and its editable Room Name defaults to the DSH conversation title.
- Host runtime settings now apply token lifetime, member/message/queue limits; Agent tool approvals remain on DSH's native Host approval chain. Runtime snapshots restore room, ledger, dispatcher and approval projection state while short-lived invites and room tokens are reissued after restart.
- After the first invite is accepted, the Participant's own DSH stores a hidden Joined-room resume record. Restarting DSH never reconnects it automatically; an explicit `Connect` action re-establishes EasyTier when required and then exchanges the saved credential for a fresh room token.
- Host room state is atomically persisted under `DSH_HOME/collab/v1/state.json` (default `~/.dsh/collab/v1/state.json`). Room/member state, timeline, queue and approvals survive a clean Host restart; unfinished Agent work is rebound to the current native DSH session and returned to the queue.

## Important deployment decision

The plugin does **not** download, install, or start nginx. The plugin owns a
dedicated Collab Gateway, room authorization, HTTP/WebSocket routes, and DSH
UI. A trusted LAN deployment connects directly to that Gateway and does not
require a reverse proxy. EasyTier is the built-in virtual-network option for
cross-network reachability without a public Host address. The two-DSH browser
environment keeps all same-machine isolation under `e2e/`.

## Gateway boundary

The in-process Collab Gateway is the application service owned by this package. It listens on its own configured host/port, serves only `/collab`, authenticates invite and room tokens, enforces room permissions, manages approvals, appends the event ledger and queues the one Host Agent. It never serves the DSH UI or general DSH APIs.

A reverse proxy/tunnel is optional and user-supplied only when the Host wants an external `wss://` endpoint. It terminates TLS and forwards HTTP plus WebSocket upgrades to the dedicated Gateway. It is not needed for the LAN MVP, is not a replacement for the Collab Gateway, and is not provisioned by this package.

Same-device local-only collaboration is not a released connection mode. A fresh install binds the Gateway to loopback as a safe internal state, but cannot create an invitation until the Owner chooses `EasyTier virtual network`, `Private network`, or supplies a `Custom WSS endpoint`. Same-machine multi-DSH accommodations remain under `e2e/` only.

Participant identity is first bound by possession of a valid invite; the same invite can be accepted by multiple members during its one-hour lifetime. Subsequent requests use each member's issued room token. Optional trusted-proxy identity headers remain a deployment extension, but direct clients cannot self-assert them.

The Host state file deliberately excludes invitation secrets, short-lived room tokens and raw Participant resume credentials. It stores only SHA-256 resume credential digests and their room/member bindings. Suspending or removing a member revokes both current room tokens and durable resume credentials. The file is written as a versioned whole snapshot through a same-directory temporary file and rename, with private file/directory modes on platforms that enforce POSIX permissions. A malformed or unsupported state file stops Gateway startup instead of silently replacing room history.

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

This is the repeatable protocol endpoint for development on one machine; two physical hosts are not required. The test uses the same Gateway, token store, stream upgrade and Host adapter used by DSH composition.

For complete browser testing, run `e2e/prepare.ps1`, then start
`e2e/start.ps1 -Client A` and `e2e/start.ps1 -Client B` in separate terminals.
They install the same complete plugin through DSH's official profile command,
use isolated `DSH_HOME` directories, and expose the two DSH UIs at `3082` and
`3083`. Both independent Collab Gateways start from the same released preferred
port `4310`; the first claims it and the second automatically selects the next
available port. Both clients advertise a detected private IPv4 address, so
either can share its current DSH session and invite the other through the
released `Private network` path. Port selection carries no role or identity.
See
[`e2e/README.md`](./e2e/README.md).

## DSH package shape

The bundle patch contains one row:

```yaml
- insert:
    - id: collab-host
      name: dsh-collab
      inject: [agents, agentPresets, settings, connection, fs, subprocess]
      config:
        enabled: true
        roomId: dsh-room
        hostId: local-host
```

The package's `dsh.client` declaration supplies the browser face. A DSH profile can install the package with its normal plugin command after `pnpm build`; the Host runtime is created through the public adapter seam (`createDshCollabHostRuntime`) and receives the trusted session service. The official session-scoped conversation slot passes the current DSH session ID to the browser face, and the Gateway verifies that exact session against the Host's Agent registry before creating or reopening its room. No separate participant-only package is used.

The Host row registers the formal `dsh-collab` settings namespace. Gateway binding, the auto-selected port, exposure mode and advertised invitation endpoint are stored as one atomic object through DSH `ctx.settings`; invite tokens and short-lived room tokens remain ephemeral. Private-network users do not configure an address: the Gateway discovers a reachable private address at startup and generates the fixed `/collab` endpoint. These Gateway settings apply after a DSH restart.

Participant recovery uses a separate `dsh-collab-participant` settings namespace whose `joinedRooms` entries are hidden by the DSH schema and never rendered as configuration fields. The Participant's own DSH stores the remote endpoint, room/member binding, raw high-entropy resume credential and, for EasyTier rooms, the private overlay descriptor plus its local virtual address. This is local private state, not Host configuration and not browser `localStorage`. A rejected credential is cleared; a temporary network failure keeps it for a later explicit `Connect`. The room owner stores only the Collab resume credential digest.

## LAN Participant deployment

Do not expose the DSH listener. In network mode the dedicated Collab Gateway binds `0.0.0.0` on its own port; the invitation advertises a reachable private IP using `ws://<private-ip>:<port>/collab`. The Participant installs the same complete plugin and pastes the invitation. Possession of the valid invitation establishes the initial Participant identity; the invitation can be used by multiple members during its one-hour lifetime. Room `@agent` requests always use the Host Agent, while private Side Work runs only after the Participant explicitly starts it on their own local DSH Agent.

Plain `ws://` accepts only literal loopback, RFC1918/link-local, `100.64.0.0/10`, ULA and IPv6 link-local addresses. Public IPs and hostnames require a user-supplied `wss://` endpoint. The plugin does not create a tunnel, configure a router, issue a certificate, or operate an official Relay in this MVP.

The automated `tests/integration/e2e-local.test.ts` exercises this dedicated listener directly with two Participant clients. The isolated two-DSH environment under `e2e/` is the browser-level test harness; it adds no production port rewriting or proxy behavior.

## EasyTier Participant deployment

EasyTier is opt-in per explicit share or join action. The Owner Gateway binds
its normal dedicated port and a headless EasyTier process advertises the fixed
room-owner virtual address `10.231.0.1`. A Participant starts its own headless
process, waits for a direct or relayed route, and exposes a loopback bridge to
the browser client. The browser then uses the unchanged Collab `/join`, token,
room, event and WebSocket protocol through that bridge.

Each DSH instance supports one active EasyTier room at a time. Installing the
plugin, starting DSH and merely listing a saved room do not download or start
EasyTier, start the Gateway, share a room or reconnect a Participant. The first
explicit EasyTier action prepares the pinned Windows no-TUN artifact. Disconnect,
forget, stop sharing and DSH shutdown stop the managed process. The default
community shared node is best-effort and can be replaced in settings; Collab
does not operate or promise availability for that node.

## Design and development log

- Architecture, slot/service/patch boundaries, role model, UI states and phased plan: [design.md](./design.md)
- Accepted native-Session, Better Sidebar, ChangeSet and EasyTier MVP: [Collab Workspace MVP v2](./docs/plans/collab-workspace-mvp-v2.md)
- Unit-by-unit implementation records and commits: [dev_log.md](./dev_log.md)
- HTTP/WebSocket wire contract: [protocol.md](./protocol.md)
