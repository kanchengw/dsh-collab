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
5. Sends one explicit `dsh` message, automatically dispatches it to the one Host Agent, records the Host followup and fans out an Agent output event.
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

The Host row registers the formal `dsh-collab` settings namespace. Gateway host, port and exposure mode are stored as one atomic object through DSH `ctx.settings`; invite tokens and room/member join fields remain ephemeral UI state and are never persisted as plugin configuration. These Gateway settings apply after a DSH restart.

## Remote Participant deployment

Do not expose the DSH listener directly. The collab route is registered on DSH's existing `webServer`, so the DSH CLI/profile owns the actual listen host, TLS and port. Keep DSH on loopback and publish only `/collab` through an authenticated reverse proxy or equivalent private-network gateway.

Use a dedicated backend source address or socket for the proxy. The Gateway trusts the TCP peer address, not `X-Forwarded-For`, and must be able to distinguish the proxy from a local browser or process. For example, configure the Host row as follows when the proxy binds its upstream connection to `127.0.0.2`:

```yaml
- insert:
    - id: collab-host
      name: dsh-collab
      inject: [webServer, agents, settings]
      config:
        enabled: true
        roomId: dsh-room
        hostId: local-host
        allowLoopbackPrincipal: false
        trustedProxyAddresses: [127.0.0.2]
        trustedProxyMarkerHeader: x-dsh-proxy
        trustedPrincipalHeader: x-authenticated-user
        title: DSH Collaboration
        hostDisplayName: Local Host
```

The reverse proxy must authenticate the participant before forwarding, strip participant-supplied identity headers, set both configured headers itself, restrict browser origins, proxy WebSocket upgrades, and avoid logging the WebSocket token query. This nginx fragment shows the required boundary; `$authenticated_user` is a placeholder produced by the deployment's authentication module, not a client header:

```nginx
location /collab/ {
    # Authenticate here and reject the request unless this variable is set.
    proxy_bind 127.0.0.2;
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header X-DSH-Principal-Id "";
    proxy_set_header X-Authenticated-User $authenticated_user;
    proxy_set_header X-DSH-Proxy "1";
}
```

The Participant installs the same complete `dsh-collab` package in their DSH, opens its official plugin settings card, and saves the public URL including `/collab`, such as `https://collab.example/collab`. Joining a valid invite automatically selects Participant mode and all room/Agent traffic uses that Host URL; the Participant's local DSH Agent is never called. The URL field rejects credentials, query strings, fragments and paths other than `/collab`.

For one-machine UI testing, run two DSH Web profiles on different ports and put the same authenticated proxy boundary in front of the Host profile. A browser tab must not be treated as the proxy merely because both are on loopback. `tests/integration/e2e-local.test.ts` uses `127.0.0.2` as the simulated trusted proxy source and verifies that a direct `127.0.0.1` request with forged marker and identity headers is rejected. A physical second-machine run is still a release acceptance check; it is not required for the automated regression suite.

## Design and development log

- Architecture, slot/service/patch boundaries, role model, UI states and phased plan: [design.md](./design.md)
- Unit-by-unit implementation records and commits: [dev_log.md](./dev_log.md)
- HTTP/WebSocket wire contract: [protocol.md](./protocol.md)
