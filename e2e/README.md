# Two-DSH browser environment

This test environment runs the same complete `dsh-collab` package in two
isolated DSH homes on one physical machine. It does not use a reverse proxy or
change production endpoint selection. The Host settings overlay selects the
released `Private network` path; it does not restore a local-only product mode.

```powershell
./e2e/prepare.ps1
./e2e/start-host.ps1
./e2e/start-participant.ps1
```

`prepare.ps1` automatically selects a private IPv4 address from this machine.
If it selects the wrong adapter, pass the address explicitly:

```powershell
./e2e/prepare.ps1 -HostAddress 192.168.1.20
```

Run the two start scripts in separate terminals, then open:

- Host DSH: `http://127.0.0.1:3082`
- Participant DSH: `http://127.0.0.1:3083`

The Host Collab Gateway listens at `0.0.0.0:4312` and advertises
`ws://<private-ip>:4312/collab`; the Participant's local Host Gateway listens
independently at `127.0.0.1:4313`. A Participant receives the remote `4312`
endpoint only through the Host invitation. DSH UI listeners remain loopback at
`3082` and `3083` and are never exposed by Collab.

Generated DSH homes live under `e2e/.state/` and are excluded from Git.
`dsh-host.patch.yml`, `dsh-participant.patch.yml`, and
`dsh-host.settings.patch.yml` are test overlays. Both profiles install the same
package from the project root, so release changes require only rebuilding and
rerunning `prepare.ps1`; there is no copied test source tree.
