# Slashbin patches

Branch `slashbin` = upstream tag `v2026.1005.0` + the commits below. Install with
`slashbin/install.sh`; the service unit lives in
`xrgarcia/slashbin-engineering-manager` at `scripts/systemd/paperclip.service`.

| Patch | Source | Touches |
|---|---|---|
| Uploaded image avatars per agent | upstream PR paperclipai/paperclip#15095 (open), cherry-picked with `-x` | `packages/shared`, `ui` |
| Comment-only agent keys: a key minted by a board user with scope `{kind: "comment_only", issueId}` may post comments on that one issue with no heartbeat run, and reach no other route | Slashbin (EM#599: Nova comments for a ChatGPT user, outside any run) | `packages/shared`, `server` (`middleware/auth.ts`, `middleware/comment-only-key.ts`, `routes/issues.ts`) |

**Rule: patches stay inside `packages/shared`, `ui`, and the server files listed in
`server-overlay.sh`.** `install.sh` and the Railway image (EM repo
`deploy/jerky-paperclip/Dockerfile`) overlay the shared and UI builds, and compile only
those server files onto the published server build. A patch that touches another
server file must add it to `SERVER_FILES`; one touching the CLI, runner or adapters
needs a new install path first.

**Upgrading:** rebase `slashbin` onto the new tag, drop any patch upstream has merged,
bump `VERSION` in `install.sh`, run it, restart the service.
