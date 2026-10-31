# Security Policy

## Reporting

Please report suspected vulnerabilities privately through a GitHub security
advisory for the repository. Do not open a public issue containing invitation
tokens, room tokens, resume credentials, workspace contents, or other private
collaboration data.

## Supported versions

Security fixes are applied to the current release line. The compatibility
baseline for this development snapshot is documented in `e2e/README.md`.

## Deployment boundary

The Collab Gateway is a dedicated listener and is not a replacement for the
DSH UI listener. Do not expose the DSH UI listener. Public deployments require
a user-supplied `wss://` endpoint; the package does not provide a relay,
certificate, tunnel, or reverse proxy.
