# Two-DSH browser environment

This test environment runs the same complete `dsh-collab` package in two
isolated DSH homes on one physical machine. It does not use a reverse proxy or
change production endpoint selection. Both clients use the released `Private
network` path; neither profile has a preassigned room role.

```powershell
./e2e/prepare.ps1
./e2e/start.ps1 -Client A
./e2e/start.ps1 -Client B
```

The prepare script validates `apps/cli/package.json` before building or
installing the plugin and rejects any DSH repository other than
`0.2.0-rc.2`.

Compatibility baseline:

| Component | Required baseline | Evidence |
| --- | --- | --- |
| DSH runtime | `0.2.0-rc.2` | `apps/cli/package.json` preflight |
| DSH Sidebar | Official left/right Sidebar extensions from `dsh-web-app` | Collab manifest injection list and runtime registration |
| Agent Team | Not used by Collab | prepare-time dependency rejection |

The profile does not install or bundle `dsh-better-sidebar`. Collab registers its
Rooms panel and session-scoped Collab tab through the official DSH Sidebar
services shipped by `dsh-web-app`.

Run the start commands in separate terminals. Client A opens at
`http://127.0.0.1:3082`; Client B opens at `http://127.0.0.1:3083`.

Both profiles start from the released preferred Gateway port `4310`. Start
Client A first, then Client B. The released runtime claims the first available
port in `4310-4399`, persists the selected value, and derives each profile's
`ws://<private-ip>:<selected-port>/collab` endpoint. No port is assigned to a
role or client identity:

- If A creates a room and invitation, A is that room's Owner and B joins as a Participant.
- If B creates a room and invitation, B is that room's Owner and A joins as a Participant.

The DSH UI listeners remain loopback at `3082` and `3083` and are never exposed
by Collab. Generated DSH homes live under `e2e/.state/` and are excluded from
Git. The client patch is intentionally empty so the released runtime keeps DSH's
native auto directory picker; the settings overlay selects the released Private
network mode with the same preferred port for both profiles. The running plugin
selects the private address when each Gateway starts, exactly as it does for
users.

The real settings overlay is intentionally not tracked. The prepare script uses
`dsh-client.settings.patch.yml` when it exists and otherwise falls back to the
checked-in `dsh-client.settings.patch.example.yml`. To customize the harness
without publishing machine-local settings:

```powershell
Copy-Item ./e2e/dsh-client.settings.patch.example.yml ./e2e/dsh-client.settings.patch.yml
```

Both profiles install the package from the project root, so release changes
require only rebuilding and rerunning the prepare script; there is no copied
test source tree.
