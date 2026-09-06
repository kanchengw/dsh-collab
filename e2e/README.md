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
`0.1.3-alpha.1`.

Compatibility baseline:

| Component | Required baseline | Evidence |
| --- | --- | --- |
| DSH runtime | `0.1.3-alpha.1` | `apps/cli/package.json` preflight |
| Better Sidebar | `>=0.17.1 <0.19.0` optional peer | Collab manifest and provider contract |
| Agent Team | Not used by Collab | prepare-time dependency rejection |

The profile must still provide a real compatible Better Sidebar at runtime for
the Collab Bar. This repository does not claim that an external Sidebar
checkout or installation has been verified by `prepare.ps1`.

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
Git. The Cordis overlay only replaces the native Windows directory picker for
browser automation; the settings overlay selects the released Private network
mode with the same preferred port for both profiles. The running plugin selects
the private address when each Gateway starts, exactly as it does for users.
Both profiles install the package from the project root, so release changes
require only rebuilding and rerunning the prepare script; there is no copied
test source tree.
