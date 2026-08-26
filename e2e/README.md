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

Run the start commands in separate terminals. Client A opens at
`http://127.0.0.1:3082`; Client B opens at `http://127.0.0.1:3083`.

`prepare.ps1` automatically selects a private IPv4 address from this machine.
If it selects the wrong adapter, pass the address explicitly:

```powershell
./e2e/prepare.ps1 -PrivateAddress 192.168.1.20
```

Client A's Collab Gateway listens at `0.0.0.0:4312`; Client B's listens at
`0.0.0.0:4313`. Both advertise their own `ws://<private-ip>:<port>/collab`
endpoint. These ports identify the two processes only:

- If A creates a room and invitation, A is that room's Owner and B joins as a Participant.
- If B creates a room and invitation, B is that room's Owner and A joins as a Participant.

The DSH UI listeners remain loopback at `3082` and `3083` and are never exposed
by Collab. Generated DSH homes live under `e2e/.state/` and are excluded from
Git. `dsh-client.patch.yml` and `dsh-client.settings.patch.yml` are rendered for
both profiles by `prepare.ps1`. Both profiles install the package from the
project root, so release changes require only rebuilding and rerunning the
prepare script; there is no copied test source tree.
