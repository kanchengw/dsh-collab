# EasyTier v2.6.4-collab.1 corresponding source

The distributed Windows no-TUN runtime corresponds exactly to fork commit:

```text
631b5539bff59adee292c8f8e1b1b43b40742b2f
```

It is based on upstream EasyTier `v2.6.4` commit:

```text
8428a89d2dabc94c97d370ec607c6ca142473626
```

Complete source and release material:

- Fork tag: <https://github.com/kanchengw/easytier-collab/releases/tag/v2.6.4-collab.1>
- Fork commit archive: <https://github.com/kanchengw/easytier-collab/archive/631b5539bff59adee292c8f8e1b1b43b40742b2f.zip>
- Fork repository: <https://github.com/kanchengw/easytier-collab>
- Upstream tag: <https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4>
- Upstream commit archive: <https://github.com/EasyTier/EasyTier/archive/8428a89d2dabc94c97d370ec607c6ca142473626.zip>
- Patch from upstream base: `EASYTIER-COLLAB.patch` beside this file

The pinned build and verification scripts are:

- <https://github.com/kanchengw/easytier-collab/blob/631b5539bff59adee292c8f8e1b1b43b40742b2f/collab/windows-no-tun/build.ps1>
- <https://github.com/kanchengw/easytier-collab/blob/631b5539bff59adee292c8f8e1b1b43b40742b2f/collab/windows-no-tun/verify.ps1>
- <https://github.com/kanchengw/easytier-collab/blob/631b5539bff59adee292c8f8e1b1b43b40742b2f/.github/workflows/collab-windows-no-tun.yml>

Reproduce the release from the complete fork source on Windows with Rust `1.95.0`, MSVC x64 build tools and protobuf compiler `26.0`:

```powershell
git clone --branch v2.6.4-collab.1 --depth 1 https://github.com/kanchengw/easytier-collab.git
git -C easytier-collab rev-parse HEAD
pwsh -NoProfile -File easytier-collab/collab/windows-no-tun/build.ps1
pwsh -NoProfile -File easytier-collab/collab/windows-no-tun/verify.ps1
```

The reported commit must equal the fork commit above. The verified release archive is `easytier-windows-x86_64-v2.6.4-collab.1.zip`, length `13,248,117` bytes, SHA-256 `86ae7bd23014dbec29d0b5fe1d5e46da202a4c4773f81b5feb99bfa20b9a902b`. No EasyTier binary or build directory is committed to `dsh-collab`.
