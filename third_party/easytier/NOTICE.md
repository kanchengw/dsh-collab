# EasyTier third-party notice

`dsh-collab` can download and run a modified headless EasyTier program as a separate, replaceable process. No EasyTier binary or source build output is stored in this Git repository.

The approved Windows no-TUN runtime is:

- Distribution tag: `v2.6.4-collab.1`
- Fork commit: `631b5539bff59adee292c8f8e1b1b43b40742b2f`
- Fork repository: <https://github.com/kanchengw/easytier-collab>
- Upstream project: EasyTier `v2.6.4`
- Upstream commit: `8428a89d2dabc94c97d370ec607c6ca142473626`
- Upstream repository: <https://github.com/EasyTier/EasyTier>
- License: GNU Lesser General Public License version 3
- Copyright: EasyTier contributors

The fork only removes the Windows no-TUN runtime dependency on Npcap/`Packet.dll`. It keeps EasyTier's networking protocol, peer discovery, NAT traversal, P2P/relay, encryption and RPC implementations. The build excludes TUN and FakeTCP features and uses EasyTier's existing `network-interface` dependency for Windows interface discovery.

The complete modified source is available from the public fork. This package also carries `EASYTIER-COLLAB.patch`, exact source/build instructions, and the complete LGPL-3.0 and incorporated GPL-3.0 terms. EasyTier and its contributors do not endorse or provide support for `dsh-collab`.
