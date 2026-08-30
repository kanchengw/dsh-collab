# EasyTier v2.6.4 corresponding source

`dsh-collab` uses the unmodified official EasyTier `v2.6.4` release identified by commit:

```text
8428a89d2dabc94c97d370ec607c6ca142473626
```

The complete corresponding source archive is available from the upstream project:

- Tag: <https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4>
- Commit archive: <https://github.com/EasyTier/EasyTier/archive/8428a89d2dabc94c97d370ec607c6ca142473626.zip>
- Repository: <https://github.com/EasyTier/EasyTier>

The authoritative upstream Windows build workflow is:

<https://github.com/EasyTier/EasyTier/blob/v2.6.4/.github/workflows/core.yml>

Its Windows x86_64 target is `x86_64-pc-windows-msvc`; the release workflow selects the `mimalloc` feature and builds the EasyTier workspace in release mode. A local source checkout can be verified and built with the same core inputs:

```powershell
git clone --branch v2.6.4 --depth 1 https://github.com/EasyTier/EasyTier.git
git -C EasyTier rev-parse HEAD
cargo build --manifest-path EasyTier/Cargo.toml --release --target x86_64-pc-windows-msvc --features mimalloc
```

The reported commit must equal the 40-character commit above. `dsh-collab` carries no EasyTier patch for this release. If a future Collab distribution modifies EasyTier, that distribution must replace this file with the exact modified source and matching build materials.
