#!/bin/bash
# deploy-hacker-kb.sh
# Run once on Elysium to deploy the Hacker KB
# Usage: bash deploy-hacker-kb.sh

set -e

echo "── Hacker KB Deployment ──────────────────────"

# ── 1. Create directory structure ────────────────
mkdir -p /sanctum/hacker-kb
cp kb_ingest.py      /sanctum/hacker-kb/
cp kb_mcp_server.py  /sanctum/hacker-kb/
cp requirements-kb.txt /sanctum/hacker-kb/

echo "✓ Files deployed to /sanctum/hacker-kb/"

# ── 2. Create virtualenv and install dependencies ─
python3 -m venv /sanctum/hacker-kb/venv
/sanctum/hacker-kb/venv/bin/pip install --quiet -r /sanctum/hacker-kb/requirements-kb.txt
echo "✓ Dependencies installed (venv: /sanctum/hacker-kb/venv)"

# ── 3. Initial seed from GitHub archive (fast) ───
echo "Seeding KB from GitHub archive (no rate limits)..."
/sanctum/hacker-kb/venv/bin/python /sanctum/hacker-kb/kb_ingest.py --seed-github
echo "✓ GitHub seed complete"

# ── 4. Initial GraphQL pull (live feed) ──────────
echo "Pulling from HackerOne GraphQL feed (this takes a few minutes)..."
/sanctum/hacker-kb/venv/bin/python /sanctum/hacker-kb/kb_ingest.py --full
echo "✓ Initial GraphQL pull complete"

# ── 5. Print stats ────────────────────────────────
/sanctum/hacker-kb/venv/bin/python /sanctum/hacker-kb/kb_ingest.py --stats

# ── 6. Set up cron for daily updates ─────────────
# Runs at 03:00 UTC every day (quiet time on Elysium)
CRON_JOB="0 3 * * * /sanctum/hacker-kb/venv/bin/python /sanctum/hacker-kb/kb_ingest.py >> /sanctum/hacker-kb/ingest.log 2>&1"

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -q "kb_ingest.py"; then
    echo "✓ Cron job already present — skipping"
else
    (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
    echo "✓ Cron job added: daily at 03:00 UTC"
fi

echo ""
echo "── Deployment complete ───────────────────────"
echo "  KB path:     /sanctum/hacker-kb/"
echo "  MCP server:  python /sanctum/hacker-kb/kb_mcp_server.py"
echo "  Cron:        daily at 03:00 UTC (incremental)"
echo ""
echo "  To add to Herald's Caddyfile as an MCP endpoint:"
echo "  See README-hacker-kb.md"
echo "─────────────────────────────────────────────"
