# Cloudflare D1 token requirements

The repository's D1 workflow uses the GitHub secret `WRANGLER_API_TOKEN`.

## Current CI behavior (manual apply)

Because the configured Cloudflare token cannot perform D1 write operations,
CI no longer attempts `wrangler d1 migrations apply --remote`. Instead:

- The **Deploy backend** workflow and the manual **D1 migrations** workflow run
  `backend/scripts/print-d1-migration-sql.sh`, which prints the SQL for any
  newly added migrations (and lists all migrations for reference) to the job
  logs and the GitHub Step Summary.
- Copy that SQL and run it manually in the Cloudflare Dashboard
  (**D1 → crypto_pulse_db → Console**).
- This step never contacts the Cloudflare API, so the rest of the pipeline
  (lint, build, tests, Worker deploy) is no longer blocked by the D1 auth error.

Once the token below is granted D1 write access, automated apply can be
re-enabled by restoring `wrangler d1 migrations apply crypto_pulse_db
--config wrangler.toml --remote` in `.github/workflows/deploy.yml`.

## Root cause of the previous failure

The token currently configured can authenticate to Cloudflare and read basic D1 metadata such as `wrangler d1 info`, but it cannot execute remote D1 write/query operations such as:

- `wrangler d1 migrations apply ... --remote`
- `wrangler d1 execute ... --remote --command ...`

This is why the workflow fails with permission errors like:

- `Authentication error [code: 10000]`
- `You do not have permission to perform this operation. [code: 7500]`

## Required fix

Create or update the GitHub secret `WRANGLER_API_TOKEN` so it has D1 permissions for the production database/account.

At minimum, the token used by the D1 workflow must be able to:

- read D1 database metadata
- execute remote D1 queries
- apply D1 migrations

In Cloudflare, create a token for the same account that owns:

- account id: `0ea8292ec77cc8fabb1bdc1b73127a19`
- database: `crypto_pulse_db`
- database id: `15f49e2f-08bf-4dc5-8ec5-0860429fc0c4`

Then update the GitHub Actions secret:

- `WRANGLER_API_TOKEN`

## Expected result after updating the token

After replacing the token with one that has proper D1 access:

1. run `D1 migrations` with `action = apply`
2. inspect the schema
3. re-test registration against the live backend
