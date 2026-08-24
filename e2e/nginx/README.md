# Local two-DSH nginx E2E

This harness reserves these ports:

- DSH Host backend: `127.0.0.1:3082`
- DSH Participant backend: `127.0.0.1:3083`
- Host browser entry: `http://127.0.0.1:3182`
- Participant browser entry: `http://127.0.0.1:3183`

The `/collab/` route on both nginx entry points is forwarded to the Host DSH
on `3082`. The Participant DSH on `3083` serves the Participant page itself;
its browser client uses `http://127.0.0.1:3183/collab` as its Gateway URL.

The config is local-test-only. It uses fixed `host` and `participant`
identities instead of an SSO module, binds proxy upstream connections to
`127.0.0.2`, and marks them with `X-DSH-Proxy: 1`. Do not deploy this file as
production authentication.

Start nginx from this directory so its relative `logs/` paths stay local:

```powershell
nginx -p E:/projects/dsh-collab/e2e/nginx/ -c nginx.conf -t
nginx -p E:/projects/dsh-collab/e2e/nginx/ -c nginx.conf
```

Stop it after both DSH profiles have been closed:

```powershell
nginx -p E:/projects/dsh-collab/e2e/nginx/ -c nginx.conf -s stop
```
