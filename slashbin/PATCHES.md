# Slashbin patches

Branch `slashbin` = upstream tag `v2026.1005.0` + the commits below. Install with
`slashbin/install.sh`; the service unit lives in
`xrgarcia/slashbin-engineering-manager` at `scripts/systemd/paperclip.service`.

| Patch | Source | Touches |
|---|---|---|
| Uploaded image avatars per agent | upstream PR paperclipai/paperclip#15095 (open), cherry-picked with `-x` | `packages/shared`, `ui` |
| Comment-only agent keys: a key minted by a board user with scope `{kind: "comment_only", issueId}` may post comments on that one issue with no heartbeat run, and reach no other route | Slashbin (EM#599: Nova comments for a ChatGPT user, outside any run) | `packages/shared`, `server` (`middleware/auth.ts`, `middleware/comment-only-key.ts`, `routes/issues.ts`) |
| Bridged seats reconcile their own lost legacy run: the assignee agent of a `process`-adapter seat may send `executionReconciliation` to `POST /issues/:id/recovery-actions/resolve` for a `legacy_execution_requires_reconciliation` hold (outcome `restored`, status `todo`). Every other check (run owner, terminal status, live pid, leases) is unchanged; other seats and causes still need the board | Slashbin (EM#609: a lost bridge waiter left a hidden no-replay hold that only a board operator could clear, with nothing for them to inspect) | `server` (`routes/issues.ts`) |
| Credited comment authors: an instance-admin board key may send `x-slashbin-comment-author: agent:<id>` or `user:<id>`, and the comment it posts (POST comments, or a PATCH's inline `comment`) is saved under that author. Only the author changes: authorization, the activity log and every status, review and reopen rule still see the board user. Any other caller sending it gets 403, and an author not on the issue's company gets 422 | Slashbin (Ray, 2026-10-16: the GitHub→Paperclip sync wrote every comment as Ray; Paperclip is the golden source for who each agent is on GitHub, as agent `metadata.githubLogin`) | `server` (`middleware/auth.ts`, `middleware/comment-author.ts`, `routes/issues.ts`, `types/express.d.ts`) |

**Rule: patches stay inside `packages/shared`, `ui`, and the server files listed in
`server-overlay.sh`.** `install.sh` and the Railway image (EM repo
`deploy/jerky-paperclip/Dockerfile`) overlay the shared and UI builds, and compile only
those server files onto the published server build. A patch that touches another
server file must add it to `SERVER_FILES`; one touching the CLI, runner or adapters
needs a new install path first.

**Upgrading:** rebase `slashbin` onto the new tag, drop any patch upstream has merged,
bump `VERSION` in `install.sh`, run it, restart the service.
