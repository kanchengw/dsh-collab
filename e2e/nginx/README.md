# Local two-DSH nginx E2E

This local-only acceptance harness requires a separately installed nginx. The
production `dsh-collab` package does not install or start nginx. The harness is
kept under `e2e` only until the LAN acceptance run replaces it.

This harness reserves these ports:

- DSH Host backend: `127.0.0.1:3082`
- DSH Participant backend: `127.0.0.1:3083`
- Host DSH user entry: `http://127.0.0.1:3082`
- Participant DSH user entry: `http://127.0.0.1:3083`
- Hidden Host nginx proxy: `127.0.0.1:3182`
- Hidden Participant nginx proxy: `127.0.0.1:3183`

Open the two nginx proxy URLs for this harness. Both `/collab/` routes are
forwarded to the Host DSH on `3082`; the proxy injects the test identity and
permits only its paired DSH origin for CORS.

The config is local-test-only. It uses fixed `host` and `participant`
identities instead of an SSO module, binds proxy upstream connections to
`127.0.0.2`, and marks them with `X-DSH-Proxy: 1`. Do not deploy this file as
production authentication.

From the repository root, start two real DSH processes with the overlays:

```powershell
node $env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --patch .\e2e\dsh-host.patch.yml --port 3082
node $env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --patch .\e2e\dsh-participant.patch.yml --port 3083
```

Start nginx separately with `e2e/nginx/nginx.conf`, then open the Host proxy at
`http://127.0.0.1:3182` and the Participant proxy at
`http://127.0.0.1:3183`. Stop nginx separately after the run.
