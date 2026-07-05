# Automated Workflow Failure Reporting

This repository includes an automated workflow failure reporter:

- `.github/workflows/failure-report.yml`

## What it does

Whenever one of these workflows finishes with a failure:
- `CI`
- `Deploy backend`
- `Security`

GitHub Actions automatically triggers a follow-up workflow that:

1. Detects the failed run
2. Collects workflow metadata
3. Lists failed jobs and failed steps
4. Downloads the full workflow logs as a ZIP artifact
5. Uploads a debugging artifact named like:
   - `workflow-failure-report-<run-id>`

## What you get

Each failure report artifact contains:

- `summary.md` — a readable summary of what failed
- `workflow-logs.zip` — the raw logs for the failed workflow run

## Why this helps

This makes debugging much faster because we no longer need to manually inspect every workflow from scratch. The failure reporter gives a single place to start:

- which workflow failed
- which job failed
- which step failed
- raw logs ready for download

## Usage

No manual action is required.

Whenever a tracked workflow fails, the report workflow runs automatically.
