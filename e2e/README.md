# Two-DSH browser environment

This test environment runs the same complete `dsh-collab` package in two
isolated DSH homes on one physical machine. It does not use a reverse proxy or
change production endpoint selection.

```powershell
./e2e/prepare.ps1
./e2e/start-host.ps1
./e2e/start-participant.ps1
```

Run the two start scripts in separate terminals, then open:

- Host DSH: `http://127.0.0.1:3082`
- Participant DSH: `http://127.0.0.1:3083`

The Host Collab Gateway listens at `127.0.0.1:4312`; the Participant's local
Host Gateway listens independently at `127.0.0.1:4313`. A Participant receives
the remote `4312` endpoint only through the Host invitation.

Generated DSH homes live under `e2e/.state/` and are excluded from Git.
