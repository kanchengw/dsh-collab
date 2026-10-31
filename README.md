![dsh-collab GitHub header](https://raw.githubusercontent.com/kanchengw/dsh-collab/main/assets/dsh-collab-github-header-roundtable-v9-chat-team.png)

# dsh-collab

`dsh-collab` adds human collaboration rooms to DeepSeek Harness (DSH). One
installable package provides both faces of a room:

- the **Host** owns the room workspace, invitation, Gateway and the single
  authoritative DSH Agent session;
- each **Participant** joins from their own DSH installation, collaborates on
  the shared workspace, and can start private Side Work with their own local
  DSH Agent.

The package never exposes the DSH UI listener and never gives a Participant
direct access to the Host Agent or Host filesystem.

> **Project status:** pre-1.0. The production Room Workspace path, native DSH
> Sidebar integration, DSH `0.2.0-rc.2` adaptation, and dual-client UI/network
> acceptance are implemented. The MVP supports one active room per DSH
> instance.

## What you can do

- Create an invitation-only collaboration room from a Git workspace.
- Share discussion and work updates with the room.
- Create tasks, link them to ChangeSets, assign reviewers and approve changes.
- Publish and synchronize versioned workspace snapshots in both directions.
- Review changes through an owner-controlled apply flow.
- Run private Side Work on a Participant's own DSH Agent without transferring
  room authority.
- Connect over a trusted private network, an EasyTier virtual network, or a
  user-supplied `wss://` endpoint.

The room surface is organized as **Activity / Tasks / Changes / Reviews** and
is embedded in DSH's native left and right Sidebars.

## How it works

### One package, two runtime roles

The same package is installed on every machine. Room role is selected at
runtime from trusted local session and token evidence, not from a separate
Participant build or a preassigned port.

- The Host owns one dedicated Collab Gateway and one authoritative Host Agent
  queue.
- A Participant joins through an invitation and receives a room token.
- Optional private Side Work uses the Participant's local DSH Agent. It does
  not replace, control, or write through the Host Agent.

### Host workspace and synchronization

The Host creates a Room Workspace from a Git directory. The initial snapshot
contains tracked and non-ignored untracked files, up to **1 GiB total**. Git
ignored files and `.git` metadata are excluded.

Participants can publish workspace versions as well as the Host. The room
stores version history, ChangeSets and review state so both sides can inspect
what changed before an owner applies it. Do not place credentials in files that
are tracked by the shared Git workspace: tracked content is part of the
collaboration snapshot.

### Gateway boundary

The Collab Gateway is a dedicated HTTP and WebSocket listener that serves only
`/collab`. It authenticates invitations and room tokens, enforces room
permissions, records the event ledger and manages approvals. It does not proxy
the DSH UI or general DSH APIs.

A reverse proxy or tunnel is optional and user-supplied. It is needed only when
the Host chooses a public `wss://` endpoint. The package does not provision
nginx, a relay, a certificate or a router rule.

## Requirements

| Component | Requirement |
| --- | --- |
| DSH | `0.2.0-rc.2` |
| Node.js | `>=22`; CI uses Node.js 24 |
| pnpm | `11.19.0` |
| Host workspace | A Git repository |
| EasyTier mode | Windows no-TUN artifact prepared on first use |

DSH versions outside the `0.2.x` release line are not compatibility targets for
this snapshot.

## Install from source

```powershell
git clone https://github.com/kanchengw/dsh-collab.git
cd dsh-collab
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Install the built package into the DSH web profile. Use the package directory's
absolute path:

```powershell
dsh plugin --profile web add C:\path\to\dsh-collab
```

If DSH is run from a source checkout, use that checkout's CLI entry point:

```powershell
pnpm dsh plugin --profile web add C:\path\to\dsh-collab
```

Restart or reload DSH after installing a new build. The plugin uses DSH's
native directory picker; it does not provide a separate Electron or browser
directory chooser.

## Quick start

### Host

1. Open a native DSH session and select a Git workspace.
2. Open **Collab Rooms** in the left Sidebar and create the room workspace.
3. In Collab settings, choose `Private network`, `EasyTier virtual network`, or
   `Custom WSS endpoint`.
4. Share the room and create an invitation.
5. Send the invitation through a trusted channel.

The same invitation can be accepted by multiple Participants during its
one-hour lifetime. Treat it like a room password.

### Participant

1. Install the same `dsh-collab` build.
2. Open **Collab Rooms** and paste the invitation.
3. Enter a display name and join.
4. Wait for the initial workspace snapshot to finish downloading. The join
   surface reports the file count and total size while the room is prepared.
5. Open the room's bound DSH workspace to work with the shared files.

A Participant cannot join another room while a room is active. Stop or
disconnect the current room first.

## Connection modes

| Mode | Use when | Notes |
| --- | --- | --- |
| `Private network` | Host and Participants are on the same trusted LAN, VPN or overlay network | Advertises a reachable private IP over `ws://` |
| `EasyTier virtual network` | Cross-network reachability is needed without a public Host address | Creates an opt-in virtual network; the default community shared node is best effort |
| `Custom WSS endpoint` | The Host supplies a TLS endpoint through their own reverse proxy or tunnel | The package does not create or operate the endpoint |

Plain `ws://` accepts only literal loopback, RFC1918/link-local addresses,
`100.64.0.0/10`, ULA and IPv6 link-local addresses. Public IPs and hostnames
require a user-supplied `wss://` endpoint.

EasyTier is started only by an explicit share or join action. Installing the
plugin, starting DSH, or listing a saved room does not download EasyTier,
start a Gateway, share a room or reconnect a Participant.

## Persistence and recovery

- Host room state is stored under
  `DSH_HOME/collab/v1/state.json` by default.
- Host state excludes invitation secrets, short-lived room tokens and raw
  Participant resume credentials.
- The Host stores SHA-256 digests of durable resume credentials and their
  room/member bindings.
- A Participant's joined-room record stays in its own DSH settings and is not
  reconnected automatically on restart. Use **Connect** when appropriate.
- Suspending or removing a member revokes current room tokens and durable
  resume credentials.
- A malformed or unsupported Host state file stops Gateway startup instead of
  silently replacing room history.

## Security and privacy

- Do not expose the DSH UI listener. Only the dedicated Collab Gateway is used
  for collaboration.
- Invitations and room tokens are bearer credentials. Do not paste them into
  public issues, screenshots or logs.
- Participants never receive Host filesystem access outside the shared Room
  Workspace.
- The initial snapshot and later published versions include Git tracked and
  non-ignored untracked files. Review the workspace before sharing it.
- The repository ignores local settings overlays, runtime state and generated
  diagnostics. Local DSH profiles under `e2e/.state/` are private test state.
- Report vulnerabilities privately through the process in
  [SECURITY.md](./SECURITY.md).

## Current limitations

- One active collaboration room per DSH instance.
- One authoritative Host Agent queue per room.
- Git is required for the Host workspace and snapshot capture.
- Workspace snapshots are limited to 1 GiB total.
- EasyTier allows one active EasyTier room per DSH instance.
- EasyTier community shared-node availability is not guaranteed.
- No built-in relay, certificate authority, public tunnel or router
  configuration.
- The DSH UI is not a multi-tenant public service.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm release:check
pnpm audit --audit-level=high
npm pack --dry-run
```

`pnpm test` runs the unit and integration suites, including the local
HTTP/WebSocket E2E flow. The local flow creates a real Gateway, joins two
Participants, verifies room messaging and cursor recovery, and confirms that
the retired `target: "dsh"` room route is rejected.

For the two-DSH browser harness on Windows, see
[e2e/README.md](./e2e/README.md). It expects a DSH source checkout at the
sibling path `../deepseek-harness` by default.

## Documentation

- [Wire protocol](./protocol.md)
- [Two-DSH browser environment](./e2e/README.md)
- [Security policy](./SECURITY.md)
- [Changelog](./CHANGELOG.md)
- [License](./LICENSE)

## Contributing

Issues and pull requests are welcome. Keep changes focused, include regression
tests, and run the checks in **Development** before opening a pull request. Do
not include invitation tokens, room credentials, workspace contents or local
configuration in an issue or commit.

## License

MIT. EasyTier-derived files retain their upstream licenses and notices under
[`third_party/easytier/`](./third_party/easytier/).
