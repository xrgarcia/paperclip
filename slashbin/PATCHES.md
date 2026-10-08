# Slashbin patches

Branch `slashbin` = upstream tag `v2026.1005.0` + the commits below. Install with
`slashbin/install.sh`; the service unit lives in
`xrgarcia/slashbin-engineering-manager` at `scripts/systemd/paperclip.service`.

| Patch | Source | Touches |
|---|---|---|
| Uploaded image avatars per agent | upstream PR paperclipai/paperclip#15095 (open), cherry-picked with `-x` | `packages/shared`, `ui` |

**Rule: patches stay inside `packages/shared` and `ui`.** `install.sh` overlays only
those two builds onto the published npm release. A patch touching the server, CLI or
adapters needs a different install path, so change `install.sh` first.

**Upgrading:** rebase `slashbin` onto the new tag, drop any patch upstream has merged,
bump `VERSION` in `install.sh`, run it, restart the service.
