# Local two-DSH nginx E2E

This acceptance run uses the same runtime path as an end user: the installed
`dsh-collab` plugin starts its bundled nginx automatically and keeps the nginx
window hidden. The two overlays only select the Host and Participant roles.

This harness reserves these ports:

- DSH Host backend: `127.0.0.1:3082`
- DSH Participant backend: `127.0.0.1:3083`
- Host DSH user entry: `http://127.0.0.1:3082`
- Participant DSH user entry: `http://127.0.0.1:3083`
- Hidden Host nginx proxy: `127.0.0.1:3182`
- Hidden Participant nginx proxy: `127.0.0.1:3183`

Users continue to open the two DSH URLs. The plugin routes its browser
requests from `3082` and `3083` through the corresponding hidden nginx proxy;
both `/collab/` routes are forwarded to the Host DSH on `3082`. The proxy
injects the test identity and permits only its paired DSH origin for CORS.

The config is local-test-only. It uses fixed `host` and `participant`
identities instead of an SSO module, binds proxy upstream connections to
`127.0.0.2`, and marks them with `X-DSH-Proxy: 1`. Do not deploy this file as
production authentication.

From the repository root, start two real DSH processes with the overlays:

```powershell
node $env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --patch .\e2e\dsh-host.patch.yml --port 3082
node $env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --patch .\e2e\dsh-participant.patch.yml --port 3083
```

Open the Host DSH at `http://127.0.0.1:3082` and the Participant DSH at
`http://127.0.0.1:3083`. Close both DSH processes to let the plugin stop and
remove its hidden nginx processes.

The checked-in standalone nginx config remains available for low-level proxy
diagnostics, but it is not the normal runtime path.
