# Cloudflare D1 token requirements

The CI workflows authenticate to Cloudflare non-interactively using the GitHub
secret `CLOUDFLARE_WORKERS_API_TOKEN` (read into `CLOUDFLARE_API_TOKEN`).

## Actual root cause of the earlier failures

Both `wrangler deploy` and `wrangler d1 migrations apply --remote` failed with
the **same** error:

```
A request to the Cloudflare API (/memberships) failed.
Authentication error [code: 10000]
```

This was **not** a missing D1 write permission. When `account_id` is not
configured, Wrangler tries to auto-discover the account by calling
`/memberships`, and the narrowly scoped CI token is not allowed to list
memberships — so every command died before reaching the actual Workers/D1
operation.

## Fix (applied)

Pin the account so Wrangler never calls `/memberships`:

- `account_id = "0ea8292ec77cc8fabb1bdc1b73127a19"` in `backend/wrangler.toml`
- `CLOUDFLARE_ACCOUNT_ID` env var in the deploy and D1 workflow steps
- `send_metrics = false` to avoid telemetry calls

With the account pinned, both the Worker deploy **and** the automated D1
migration apply run non-interactively. Migration state is therefore tracked in
D1's `d1_migrations` table, and the workflow prints the current status via
`wrangler d1 migrations list --remote`.

## Current CI behavior

- **Deploy backend** (`deploy.yml`, on push to `backend/**`): runs
  `wrangler d1 migrations apply --remote` (real gate), prints
  `wrangler d1 migrations list --remote`, then deploys the Worker.
- **D1 migrations** (`d1-migrations.yml`, manual): `apply`, `list`, or
  `generate-sql` (prints SQL via `backend/scripts/print-d1-migration-sql.sh`
  as a manual fallback if remote apply is ever unavailable).

## Reconciling migrations applied manually in the Dashboard

If a migration was already applied by hand in the Cloudflare Dashboard, it is
**not** recorded in the `d1_migrations` tracking table, so the automated apply
will try to run it again and fail on non-idempotent statements (e.g.
`ALTER TABLE ... ADD COLUMN`). Mark it as applied so Wrangler skips it:

```sql
-- Run once in the D1 Console for each migration already applied by hand:
INSERT INTO d1_migrations (name)
VALUES ('0013_add_exchange_environment_to_users.sql');
```

## If the token still lacks D1 write access

Should a future run fail on the actual D1 write call (permission error
`[code: 7500]`) rather than `/memberships`, update
`CLOUDFLARE_WORKERS_API_TOKEN` so the token can, for the account
`0ea8292ec77cc8fabb1bdc1b73127a19` and database `crypto_pulse_db`
(`15f49e2f-08bf-4dc5-8ec5-0860429fc0c4`):

- read D1 database metadata
- execute remote D1 queries
- apply D1 migrations (D1: Edit)
