#!/usr/bin/env bash
#
# print-d1-migration-sql.sh
#
# Automated remote Cloudflare D1 migrations are disabled in CI because the
# available Cloudflare API token cannot perform D1 write operations
# (`wrangler d1 migrations apply --remote` fails with Authentication error
# [code: 10000]). Instead of failing the pipeline, this script prints the SQL
# for the migrations that must be applied MANUALLY in the Cloudflare Dashboard
# (D1 -> crypto_pulse_db -> Console).
#
# It highlights migration files that were added/modified in the current push so
# they can be copy-pasted directly, and also lists every migration for
# reference. The script never fails the build (always exits 0).
#
# Optional first argument (or the MIGRATION_DIFF_BASE env var): a git ref to
# diff against when detecting newly added migrations. Defaults to the previous
# commit.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
MIG_DIR="$REPO_ROOT/backend/migrations"

# Append a line to the GitHub step summary when running inside GitHub Actions.
summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# Print a line to stdout (build logs) and the step summary.
emit() {
  printf '%s\n' "$1"
  summary "$1"
}

# Print the contents of a migration file, fenced as SQL, to both destinations.
print_file() {
  local f="$1"
  local content
  content="$(cat "$f")"
  emit ""
  emit "### $(basename "$f")"
  emit '```sql'
  printf '%s\n' "$content"
  summary "$content"
  emit '```'
}

emit "## D1 migration SQL — manual apply required"
emit ""
emit "Automated remote D1 migration is disabled because the CI Cloudflare token"
emit "lacks D1 write permissions (Authentication error [code: 10000])."
emit ""
emit "Copy the SQL below and run it manually in the Cloudflare Dashboard:"
emit "**D1 → crypto_pulse_db → Console**, then run only the migrations that have"
emit "not been applied yet."
emit ""

if [ ! -d "$MIG_DIR" ]; then
  emit "No migrations directory found at backend/migrations. Nothing to apply."
  exit 0
fi

# Resolve the base commit used to detect newly added/modified migrations.
BASE="${1:-${MIGRATION_DIFF_BASE:-}}"
if [ -z "$BASE" ] || [ "$BASE" = "0000000000000000000000000000000000000000" ] \
  || ! git -C "$REPO_ROOT" cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  BASE="$(git -C "$REPO_ROOT" rev-parse HEAD~1 2>/dev/null || true)"
fi

CHANGED=""
if [ -n "$BASE" ] && git -C "$REPO_ROOT" cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  CHANGED="$(git -C "$REPO_ROOT" diff --name-only --diff-filter=AM "$BASE" HEAD -- backend/migrations 2>/dev/null | sort || true)"
fi

if [ -n "$CHANGED" ]; then
  emit "---"
  emit "## Newly added / modified migrations in this push"
  emit "Run these now (in filename order):"
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    print_file "$REPO_ROOT/$rel"
  done <<<"$CHANGED"
else
  emit "_No new migration files detected in this push._"
fi

emit ""
emit "---"
emit "## All migrations (reference — only run the ones not yet applied)"
for f in "$MIG_DIR"/*.sql; do
  [ -e "$f" ] || continue
  print_file "$f"
done

emit ""
emit "---"
emit "> Note: migrations applied manually in the Dashboard are not recorded in"
emit "> Wrangler's \`d1_migrations\` tracking table. Once the CI token has D1 write"
emit "> access, re-enable automated apply so tracking stays consistent."

exit 0
