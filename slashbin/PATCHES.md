# Slashbin patches

Branch `slashbin` = upstream tag `v2026.1005.0` + the commits below. Install with
`slashbin/install.sh`; the service unit lives in
`xrgarcia/slashbin-engineering-manager` at `scripts/systemd/paperclip.service`.

| Patch | Source | Touches |
|---|---|---|
| Uploaded image avatars per agent | upstream PR paperclipai/paperclip#15095 (open), cherry-picked with `-x` | `packages/shared`, `ui` |
| Comment-only agent keys: a key minted by a board user with scope `{kind: "comment_only", issueId}` may post comments on that one issue with no heartbeat run, and reach no other route | Slashbin (EM#599: Nova comments for a ChatGPT user, outside any run) | `packages/shared`, `server` (`middleware/auth.ts`, `middleware/comment-only-key.ts`, `routes/issues.ts`) |
| Bridged seats reconcile their own lost legacy run: the assignee agent of a `process`-adapter seat may send `executionReconciliation` to `POST /issues/:id/recovery-actions/resolve` for a `legacy_execution_requires_reconciliation` hold (outcome `restored`, status `todo`). Every other check (run owner, terminal status, live pid, leases) is unchanged; other seats and causes still need the board | Slashbin (EM#609: a lost bridge waiter left a hidden no-replay hold that only a board operator could clear, with nothing for them to inspect) | `server` (`routes/issues.ts`) |
| Protected Cases: every `company-policy` Case, plus Case ids named in env `PAPERCLIP_PROTECTED_CASES`, may be written only by the editors that env lists (a user through a signed-in session, never a board key; an agent only through a standard API key whose id the env lists, never a run JWT or another key, since a board key can mint those). Every write route in `routes/cases.ts` checks it, including upsert and filing a child. Protected Cases take no attachments; their documents cannot be deleted, need a `changeSummary`, and a restore needs a current `baseRevisionId`. Unset config leaves protected Cases with no editors; invalid config refuses every Case write (503). Reads and annotation threads stay open. The Case page asks for a change summary on a protected Case and sends the restore base | Slashbin (EM#629: company policy in Cases, edited only by Ray and the PO; upstream lets any company member write any Case, and Ray's board keys act as Ray) | `server` (`routes/cases.ts`, `slashbin/protected-cases.ts`), `ui` (`api/cases.ts`, `pages/CaseDetail.tsx`, `components/IssueDocumentsSection.tsx`) |

**Rule: patches stay inside `packages/shared`, `ui`, and the server files listed in
`server-overlay.sh`.** `install.sh` and the Railway image (EM repo
`deploy/jerky-paperclip/Dockerfile`) overlay the shared and UI builds, and compile only
those server files onto the published server build. A patch that touches another
server file must add it to `SERVER_FILES`; one touching the CLI, runner or adapters
needs a new install path first.

**Upgrading:** rebase `slashbin` onto the new tag, drop any patch upstream has merged,
bump `VERSION` in `install.sh`, run it, restart the service.
