# dsh-collab

`dsh-collab` is one installable package for human collaboration around one Host-side DSH Agent session. The same package has a Host face and a Participant face; a room's trusted local-session/token evidence selects the role. A Participant never creates a local Agent or accesses the Host workspace.

## What is ready

- Versioned room protocol, HTTP Gateway, WebSocket stream, invite/join, permissions, message targeting, single Host Agent queue, steer/cancel, approval, limits, revocation, audit redaction, snapshot recovery and observability.
- One package manifest with `exports["./client"]`, `dsh.client`, `dsh.bundle.patch` and `cordis.patch.yml`.
- Structural DSH Host adapter (`src/dsh-host.ts`) and reusable Host runtime factory (`src/host-runtime.ts`). The adapter uses the public WebServer `register`/`registerUpgrade` boundary and a structural DSH session service; it does not import DSH private dispatcher code.
- Unified room UI (`src/session-ui.ts`) with Host/Participant identity, connection states, responsive room/timeline/member layout, explicit message target selection and keyboard-friendly native form controls.
- Namespaced settings UI (`src/settings.ts`) separating Host gateway exposure from Participant connection preferences, with loopback defaults and network-exposure warning.

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
5. Sends one explicit `dsh` message, drains the one Host Agent queue, records the Host followup and fans out an Agent output event.
6. Disconnects and reconnects one Participant, then verifies cursor-based event recovery.

This is the repeatable endpoint for development on one machine; two physical hosts are not required. The test uses the same Gateway, token store, stream upgrade and Host adapter used by the eventual DSH composition. It is not a claim that Chrome DevTools or the complete DSH React shell has already been browser-verified; that requires a configured DSH profile/browser test environment.

## DSH package shape

The bundle patch contains one row:

```yaml
- insert:
    - id: collab-host
      name: dsh-collab
      config:
        enabled: true
        path: /collab
```

The package's `dsh.client` declaration supplies the browser face. A DSH profile can install the package with its normal plugin command after `pnpm build`; the Host runtime is created through the public adapter seam (`createDshCollabHostRuntime`) and can be mounted by a profile-specific Host integration that supplies the trusted session service and room/session facts. No separate participant-only package is used.

## Design and development log

- Architecture, slot/service/patch boundaries, role model, UI states and phased plan: [design.md](./design.md)
- Unit-by-unit implementation records and commits: [dev_log.md](./dev_log.md)
- HTTP/WebSocket wire contract: [protocol.md](./protocol.md)
