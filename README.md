# dsh-collab

Human collaboration rooms for one host-side DSH Agent session.

The architecture and incremental implementation plan live in [design.md](./design.md). P0/P1 contain the in-memory domain core and collaboration semantics; P1.5 adds the versioned wire protocol, localhost HTTP adapter, and DSH-compatible stream upgrade boundary. UI, production persistence/security, and native DSH visual integration remain later phases.

## Commands

```sh
pnpm install
pnpm test
pnpm typecheck
```
