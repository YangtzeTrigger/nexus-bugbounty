"""
kb_ingest.py
Hacker Knowledge Base — Ingestion Pipeline
Hetzner Elysium / Nexus Bug Bounty System

Pulls disclosed vulnerability reports from:
  - HackerOne GraphQL API (public, no auth required)
  - HackerOne REST API (optional, requires API credentials)

Normalises and embeds into ChromaDB at /sanctum/hacker-kb/chroma/
Tracks ingestion cursor in /sanctum/hacker-kb/state.json for incremental updates.

Usage:
  python kb_ingest.py               # incremental update
  python kb_ingest.py --full        # full re-seed from cursor start
  python kb_ingest.py --seed-github # seed from reddelexc public report archive
  python kb_ingest.py --stats       # print KB stats and exit
"""

import argparse
import base64
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import chromadb
import requests
from chromadb.utils import embedding_functions
from tqdm import tqdm

# ─── Config ───────────────────────────────────────────────────────────────────

BASE_DIR     = Path(os.getenv('HACKER_KB_DIR', '/sanctum/hacker-kb'))
CHROMA_DIR   = BASE_DIR / 'chroma'
STATE_FILE   = BASE_DIR / 'state.json'
LOG_FILE     = BASE_DIR / 'ingest.log'

# HackerOne endpoints
H1_GRAPHQL   = 'https://hackerone.com/graphql'
H1_REST      = 'https://api.hackerone.com/v1/hackers/hacktivity'

# Embedding model — same as Nexus memory system for consistency
EMBED_MODEL  = 'all-MiniLM-L6-v2'
COLLECTION   = 'hacker_kb'

# Rate limiting
GRAPHQL_DELAY = 1.5   # seconds between paginated requests
REST_DELAY    = 1.0
BATCH_SIZE    = 100   # reports per GraphQL page (H1 max)

# ─── GraphQL Query ────────────────────────────────────────────────────────────

REPORTS_QUERY = """
query ReportsFeed($count: Int!, $cursor: String!) {
  reports(first: $count, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      title
      disclosed_at
      severity { rating score }
      weakness { name external_id }
      team { handle name }
      structured_scope { asset_type asset_identifier }
      summaries { content }
      votes { total_count }
    }
  }
}
"""

# ─── State management ─────────────────────────────────────────────────────────

def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {
        'last_cursor': '',
        'last_run': None,
        'total_ingested': 0,
        'collections': {},
    }

def save_state(state):
    BASE_DIR.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)

# ─── Logging ──────────────────────────────────────────────────────────────────

def log(msg):
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    line = f'[{ts}] {msg}'
    print(line)
    BASE_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, 'a') as f:
        f.write(line + '\n')

# ─── ChromaDB setup ───────────────────────────────────────────────────────────

def get_collection():
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=EMBED_MODEL
    )
    collection = client.get_or_create_collection(
        name=COLLECTION,
        embedding_function=ef,
        metadata={'hnsw:space': 'cosine'},
    )
    return collection

# ─── Normalisation ────────────────────────────────────────────────────────────

def normalise_graphql_node(node):
    """Convert a reports query node to a flat document."""
    # Decode base64 global ID to numeric report ID
    raw_id = node.get('id', '')
    try:
        rid = base64.b64decode(raw_id).decode().split('/')[-1]
    except Exception:
        rid = raw_id

    team   = node.get('team', {}) or {}
    votes  = (node.get('votes') or {}).get('total_count', 0)

    title    = node.get('title') or ''
    severity = (node.get('severity') or {}).get('rating', 'unknown')
    score    = (node.get('severity') or {}).get('score', None)
    weakness = (node.get('weakness') or {}).get('name') or ''
    cwe_id   = (node.get('weakness') or {}).get('external_id') or ''
    scope    = node.get('structured_scope') or {}
    asset_type  = (scope.get('asset_type') or 'unknown').lower()
    asset_id    = scope.get('asset_identifier') or ''
    disclosed   = node.get('disclosed_at') or ''
    program     = team.get('handle') or ''

    # Extract summary text
    summaries = node.get('summaries') or []
    summary   = ' '.join(s.get('content', '') for s in summaries if s.get('content'))

    # Build searchable document
    doc = f"""TITLE: {title}
SEVERITY: {severity}
WEAKNESS: {weakness} ({cwe_id})
ASSET TYPE: {asset_type}
PROGRAM: {program}
DISCLOSED: {disclosed}
SUMMARY: {summary}"""

    metadata = {
        'id':         rid,
        'title':      title[:500],
        'severity':   severity,
        'cvss_score': float(score) if score else 0.0,
        'weakness':   weakness[:200],
        'cwe_id':     cwe_id[:50],
        'asset_type': asset_type[:100],
        'asset_id':   asset_id[:200],
        'program':    program[:100],
        'disclosed':  disclosed[:30],
        'votes':      int(votes),
        'url':        f'https://hackerone.com/reports/{rid}',
        'source':     'h1_graphql',
    }

    return rid, doc, metadata


def normalise_rest_item(item):
    """Convert a REST API item to a flat document."""
    attrs = item.get('attributes', {})
    rid   = str(item.get('id', ''))

    title    = attrs.get('title', '')
    severity = attrs.get('severity_rating', 'unknown')
    cwe      = attrs.get('cwe', '')
    cve_ids  = ', '.join(attrs.get('cve_ids', []))
    disclosed = attrs.get('disclosed_at', '')
    url      = attrs.get('url', f'https://hackerone.com/reports/{rid}')
    votes    = attrs.get('votes', 0)
    bounty   = attrs.get('total_awarded_amount', 0)

    doc = f"""TITLE: {title}
SEVERITY: {severity}
CWE: {cwe}
CVE: {cve_ids}
BOUNTY: ${bounty}
DISCLOSED: {disclosed}"""

    metadata = {
        'id':         rid,
        'title':      title[:500],
        'severity':   severity,
        'cvss_score': 0.0,
        'weakness':   cwe[:200],
        'cwe_id':     cwe[:50],
        'asset_type': 'unknown',
        'asset_id':   '',
        'program':    '',
        'disclosed':  disclosed[:30],
        'votes':      int(votes),
        'url':        url,
        'source':     'h1_rest',
    }

    return rid, doc, metadata

# ─── Upsert helpers ───────────────────────────────────────────────────────────

def upsert_batch(collection, ids, docs, metas):
    if not ids:
        return 0
    before = collection.count()
    collection.upsert(documents=docs, metadatas=metas, ids=ids)
    return collection.count() - before

# ─── GraphQL ingestion ────────────────────────────────────────────────────────

def ingest_graphql(collection, state, full=False):
    cursor = '' if full else state.get('last_cursor', '')
    total_new = 0
    page = 0

    log(f'GraphQL ingestion starting (cursor: "{cursor or "start"}")')

    while True:
        payload = {
            'query': REPORTS_QUERY,
            'variables': {'count': BATCH_SIZE, 'cursor': cursor},
        }
        data = None
        for attempt in range(4):
            try:
                resp = requests.post(
                    H1_GRAPHQL,
                    json=payload,
                    headers={'Content-Type': 'application/json', 'User-Agent': 'HackerKB-Ingest/1.0'},
                    timeout=30,
                )
                if resp.status_code == 429:
                    wait = 60 * (2 ** attempt)
                    log(f'GraphQL 429 rate-limited — waiting {wait}s (attempt {attempt + 1}/4)')
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                data = resp.json()
                break
            except Exception as e:
                log(f'GraphQL request failed (attempt {attempt + 1}): {e}')
                if attempt < 3:
                    time.sleep(30)
        if data is None:
            log('GraphQL: all retries exhausted — stopping.')
            break

        items = data.get('data', {}).get('reports', {})
        nodes = items.get('nodes', [])
        page_info = items.get('pageInfo', {})
        has_next  = page_info.get('hasNextPage', False)
        end_cursor = page_info.get('endCursor', '')

        if not nodes:
            log('No nodes returned — stopping.')
            break

        ids, docs, metas = [], [], []
        for node in nodes:
            if not node:
                continue
            try:
                rid, doc, meta = normalise_graphql_node(node)
                if rid:
                    ids.append(rid)
                    docs.append(doc)
                    metas.append(meta)
            except Exception as e:
                log(f'Normalise error: {e}')

        added = upsert_batch(collection, ids, docs, metas)
        total_new += added
        page += 1

        log(f'Page {page}: {len(nodes)} fetched, {added} new. Cursor: {end_cursor[:20]}...')

        # Save cursor after each page so we can resume
        cursor = end_cursor  # advance to next page
        state['last_cursor'] = end_cursor
        state['total_ingested'] = state.get('total_ingested', 0) + added
        save_state(state)

        if not has_next:
            log('Reached end of feed.')
            break

        # If doing incremental and we hit zero new in a page, we're caught up
        if not full and added == 0:
            log('No new reports in this page — feed is current.')
            break

        time.sleep(GRAPHQL_DELAY)

    log(f'GraphQL ingestion complete: {total_new} new reports added.')
    return total_new

# ─── REST API ingestion ───────────────────────────────────────────────────────

def ingest_rest(collection, state, api_user, api_token):
    log('REST API ingestion starting...')
    total_new = 0
    page = 1

    while True:
        try:
            resp = requests.get(
                H1_REST,
                params={'page[number]': page, 'page[size]': 100},
                auth=(api_user, api_token),
                headers={'Accept': 'application/json'},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            log(f'REST API request failed (page {page}): {e}')
            break

        items = data.get('data', [])
        if not items:
            break

        ids, docs, metas = [], [], []
        for item in items:
            try:
                rid, doc, meta = normalise_rest_item(item)
                if rid:
                    ids.append(rid)
                    docs.append(doc)
                    metas.append(meta)
            except Exception as e:
                log(f'REST normalise error: {e}')

        added = upsert_batch(collection, ids, docs, metas)
        total_new += added
        log(f'REST page {page}: {len(items)} fetched, {added} new.')

        if added == 0:
            log('REST: no new reports — caught up.')
            break

        page += 1
        time.sleep(REST_DELAY)

    log(f'REST ingestion complete: {total_new} new reports added.')
    return total_new

# ─── GitHub seed ingestion ────────────────────────────────────────────────────
# reddelexc/hackerone-reports — thousands of real disclosed reports as markdown files
# Great for initial KB seeding without hitting API rate limits.

GITHUB_INDEX_URL = 'https://raw.githubusercontent.com/reddelexc/hackerone-reports/master/tops_by_program/TOPHACKERONE.md'

def ingest_github_seed(collection, state):
    """
    Seed the KB from the public reddelexc/hackerone-reports GitHub archive.
    Parses the top reports index as a lightweight bootstrap.
    For full report text, use the REST API with credentials.
    """
    log('GitHub seed ingestion starting...')

    try:
        resp = requests.get(GITHUB_INDEX_URL, timeout=30)
        resp.raise_for_status()
        content = resp.text
    except Exception as e:
        log(f'GitHub fetch failed: {e}')
        return 0

    # Current format: "1. [Title](https://hackerone.com/reports/ID) to Program - N upvotes, $B"
    ENTRY_RE = re.compile(
        r'^\d+\.\s+\[([^\]]+)\]\((https://hackerone\.com/reports/(\d+))\)\s+to\s+(.+?)\s+-\s+(\d+)\s+upvotes,\s+\$[\d,]+',
        re.IGNORECASE,
    )

    ids, docs, metas = [], [], []

    for line in content.splitlines():
        line = line.strip()
        m = ENTRY_RE.match(line)
        if not m:
            continue
        try:
            title   = m.group(1).strip()
            url     = m.group(2)
            rid     = m.group(3)          # real HackerOne report ID from URL
            program = m.group(4).strip()
            votes   = int(m.group(5))

            doc = f"""TITLE: {title}
PROGRAM: {program}
URL: {url}
SOURCE: GitHub archive (reddelexc/hackerone-reports)"""

            meta = {
                'id':         rid,
                'title':      title[:500],
                'severity':   'unknown',
                'cvss_score': 0.0,
                'weakness':   '',
                'cwe_id':     '',
                'asset_type': 'unknown',
                'asset_id':   '',
                'program':    program[:100],
                'disclosed':  '',
                'votes':      votes,
                'url':        url,
                'source':     'github_seed',
            }

            ids.append(rid)
            docs.append(doc)
            metas.append(meta)

        except Exception:
            continue

    if len(ids) < 10:
        log(f'GitHub seed WARNING: only {len(ids)} entries parsed — source format may have changed.')

    added = upsert_batch(collection, ids, docs, metas)
    log(f'GitHub seed complete: {added} new entries added.')
    return added

# ─── Stats ────────────────────────────────────────────────────────────────────

def print_stats(collection, state):
    count = collection.count()
    print(f'\n── Hacker KB Stats ────────────────────────')
    print(f'  Collection:      {COLLECTION}')
    print(f'  Total documents: {count:,}')
    print(f'  Last run:        {state.get("last_run", "never")}')
    print(f'  Total ingested:  {state.get("total_ingested", 0):,}')
    print(f'  DB path:         {CHROMA_DIR}')
    print(f'───────────────────────────────────────────\n')

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Hacker KB Ingestion Pipeline')
    parser.add_argument('--full',         action='store_true', help='Full re-seed from the beginning')
    parser.add_argument('--seed-github',  action='store_true', help='Seed from GitHub public archive')
    parser.add_argument('--rest',         action='store_true', help='Also run REST API ingestion (requires credentials)')
    parser.add_argument('--rest-user',    default=os.getenv('H1_API_USER', ''), help='HackerOne API username')
    parser.add_argument('--rest-token',   default=os.getenv('H1_API_TOKEN', ''), help='HackerOne API token')
    parser.add_argument('--stats',        action='store_true', help='Print stats and exit')
    args = parser.parse_args()

    state      = load_state()
    collection = get_collection()

    if args.stats:
        print_stats(collection, state)
        return

    log('─── Hacker KB Ingestion Starting ───')

    if args.seed_github:
        ingest_github_seed(collection, state)

    ingest_graphql(collection, state, full=args.full)

    if args.rest:
        if not args.rest_user or not args.rest_token:
            log('REST skipped — H1_API_USER and H1_API_TOKEN not set.')
        else:
            ingest_rest(collection, state, args.rest_user, args.rest_token)

    state['last_run'] = datetime.now(timezone.utc).isoformat()
    save_state(state)

    print_stats(collection, state)
    log('─── Ingestion complete ───')


if __name__ == '__main__':
    main()
