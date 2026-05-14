"""
kb_mcp_server.py
Hacker Knowledge Base — MCP Server
Nexus Bug Bounty System / Elysium

Exposes the ChromaDB hacker knowledge base as an MCP stdio server.
Bug Finder and Scope Validator agents query this before analysing targets.

Tools exposed:
  query_kb          — semantic search across all reports
  get_by_weakness   — filter by CWE/weakness name
  get_by_severity   — filter by severity rating
  get_by_asset_type — filter by asset type (web, api, mobile, etc.)
  kb_stats          — current KB statistics

Usage (stdio, wire into Herald or Nexus/Samaritan):
  python kb_mcp_server.py

MCP config for claude_desktop_config.json or Samaritan gateway:
  {
    "hacker-kb": {
      "command": "python",
      "args": ["/sanctum/hacker-kb/kb_mcp_server.py"],
      "env": { "HACKER_KB_DIR": "/sanctum/hacker-kb" }
    }
  }
"""

import json
import os
import sys
from pathlib import Path

import chromadb
from chromadb.utils import embedding_functions
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types

# ─── Config ───────────────────────────────────────────────────────────────────

BASE_DIR   = Path(os.getenv('HACKER_KB_DIR', '/sanctum/hacker-kb'))
CHROMA_DIR = BASE_DIR / 'chroma'
EMBED_MODEL = 'all-MiniLM-L6-v2'
COLLECTION  = 'hacker_kb'

# ─── Format result ────────────────────────────────────────────────────────────

def format_results(results, max_results=5):
    docs      = results.get('documents', [[]])[0]
    metas     = results.get('metadatas', [[]])[0]
    distances = results.get('distances', [[]])[0]

    output = []
    for i, (doc, meta, dist) in enumerate(zip(docs, metas, distances)):
        relevance = round((1 - dist) * 100, 1)
        entry = {
            'rank':       i + 1,
            'relevance':  f'{relevance}%',
            'title':      meta.get('title', ''),
            'severity':   meta.get('severity', 'unknown'),
            'weakness':   meta.get('weakness', ''),
            'cwe_id':     meta.get('cwe_id', ''),
            'asset_type': meta.get('asset_type', ''),
            'program':    meta.get('program', ''),
            'url':        meta.get('url', ''),
            'disclosed':  meta.get('disclosed', ''),
            'snippet':    doc[:400] if doc else '',
        }
        output.append(entry)

    return output

# ─── DB init (once at startup) ───────────────────────────────────────────────

_collection = None

def get_collection():
    global _collection
    if _collection is None:
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        ef = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name=EMBED_MODEL
        )
        _collection = client.get_or_create_collection(
            name=COLLECTION,
            embedding_function=ef,
            metadata={'hnsw:space': 'cosine'},
        )
    return _collection

# ─── MCP Server ───────────────────────────────────────────────────────────────

app = Server('hacker-kb')

@app.list_tools()
async def list_tools():
    return [
        types.Tool(
            name='query_kb',
            description=(
                'Semantic search across the hacker knowledge base of disclosed '
                'vulnerability reports. Use this to find relevant attack patterns, '
                'techniques, and precedents before analysing a target. '
                'Returns ranked results with severity, weakness, and report links.'
            ),
            inputSchema={
                'type': 'object',
                'properties': {
                    'query': {
                        'type': 'string',
                        'description': 'Natural language query — e.g. "IDOR in REST API user objects", "JWT auth bypass", "file upload RCE"',
                    },
                    'n_results': {
                        'type': 'integer',
                        'description': 'Number of results to return (default 5, max 20)',
                        'default': 5,
                    },
                    'severity_filter': {
                        'type': 'string',
                        'enum': ['critical', 'high', 'medium', 'low', 'none'],
                        'description': 'Optional: filter by minimum severity',
                        'default': 'none',
                    },
                },
                'required': ['query'],
            },
        ),
        types.Tool(
            name='get_by_weakness',
            description=(
                'Retrieve reports by weakness/vulnerability class name or CWE ID. '
                'Useful for finding precedents for a specific vulnerability type.'
            ),
            inputSchema={
                'type': 'object',
                'properties': {
                    'weakness': {
                        'type': 'string',
                        'description': 'Weakness name or CWE ID — e.g. "SQL Injection", "CWE-79", "SSRF"',
                    },
                    'n_results': {'type': 'integer', 'default': 10},
                },
                'required': ['weakness'],
            },
        ),
        types.Tool(
            name='get_by_severity',
            description='Retrieve top-voted reports filtered by severity rating.',
            inputSchema={
                'type': 'object',
                'properties': {
                    'severity': {
                        'type': 'string',
                        'enum': ['critical', 'high', 'medium', 'low'],
                    },
                    'n_results': {'type': 'integer', 'default': 10},
                },
                'required': ['severity'],
            },
        ),
        types.Tool(
            name='get_by_asset_type',
            description=(
                'Retrieve vulnerability reports for a specific asset type. '
                'Useful when the Bug Finder has identified the target technology.'
            ),
            inputSchema={
                'type': 'object',
                'properties': {
                    'asset_type': {
                        'type': 'string',
                        'description': 'Asset type — e.g. "url", "api", "mobile", "source_code", "executable"',
                    },
                    'query': {
                        'type': 'string',
                        'description': 'Optional: additional semantic filter',
                        'default': '',
                    },
                    'n_results': {'type': 'integer', 'default': 10},
                },
                'required': ['asset_type'],
            },
        ),
        types.Tool(
            name='kb_stats',
            description='Return current statistics about the knowledge base.',
            inputSchema={
                'type': 'object',
                'properties': {},
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict):
    try:
        collection = get_collection()
    except Exception as e:
        return [types.TextContent(type='text', text=f'KB unavailable: {e}')]

    # ── query_kb ──────────────────────────────────────────────────────────────
    if name == 'query_kb':
        query    = arguments.get('query', '')
        n        = min(int(arguments.get('n_results', 5)), 20)
        severity = arguments.get('severity_filter', 'none')

        where = None
        if severity and severity != 'none':
            where = {'severity': {'$eq': severity}}

        try:
            results = collection.query(
                query_texts=[query],
                n_results=n,
                where=where,
                include=['documents', 'metadatas', 'distances'],
            )
            formatted = format_results(results, n)
            return [types.TextContent(
                type='text',
                text=json.dumps({'query': query, 'results': formatted}, indent=2),
            )]
        except Exception as e:
            return [types.TextContent(type='text', text=f'Query error: {e}')]

    # ── get_by_weakness ───────────────────────────────────────────────────────
    elif name == 'get_by_weakness':
        weakness = arguments.get('weakness', '')
        n        = min(int(arguments.get('n_results', 10)), 20)

        try:
            # Semantic search using the weakness as query text
            results = collection.query(
                query_texts=[weakness],
                n_results=n,
                include=['documents', 'metadatas', 'distances'],
            )
            formatted = format_results(results, n)
            return [types.TextContent(
                type='text',
                text=json.dumps({'weakness': weakness, 'results': formatted}, indent=2),
            )]
        except Exception as e:
            return [types.TextContent(type='text', text=f'Query error: {e}')]

    # ── get_by_severity ───────────────────────────────────────────────────────
    elif name == 'get_by_severity':
        severity = arguments.get('severity', 'high')
        n        = min(int(arguments.get('n_results', 10)), 20)

        try:
            results = collection.get(
                where={'severity': {'$eq': severity}},
                include=['documents', 'metadatas'],
                limit=n,
            )
            docs   = results.get('documents', [])
            metas  = results.get('metadatas', [])
            output = []
            for doc, meta in zip(docs, metas):
                output.append({
                    'title':      meta.get('title', ''),
                    'severity':   meta.get('severity', ''),
                    'weakness':   meta.get('weakness', ''),
                    'program':    meta.get('program', ''),
                    'url':        meta.get('url', ''),
                    'votes':      meta.get('votes', 0),
                    'snippet':    doc[:300] if doc else '',
                })
            # Sort by votes descending
            output.sort(key=lambda x: x.get('votes', 0), reverse=True)
            return [types.TextContent(
                type='text',
                text=json.dumps({'severity': severity, 'results': output}, indent=2),
            )]
        except Exception as e:
            return [types.TextContent(type='text', text=f'Query error: {e}')]

    # ── get_by_asset_type ─────────────────────────────────────────────────────
    elif name == 'get_by_asset_type':
        asset_type = arguments.get('asset_type', '')
        query      = arguments.get('query', asset_type)
        n          = min(int(arguments.get('n_results', 10)), 20)

        try:
            results = collection.query(
                query_texts=[f'{asset_type} vulnerability {query}'],
                n_results=n,
                where={'asset_type': {'$eq': asset_type.lower()}},
                include=['documents', 'metadatas', 'distances'],
            )
            filter_dropped = False
            if not results.get('documents', [[]])[0]:
                # No results for asset_type filter — fall back to unfiltered semantic search
                filter_dropped = True
                results = collection.query(
                    query_texts=[f'{asset_type} vulnerability {query}'],
                    n_results=n,
                    include=['documents', 'metadatas', 'distances'],
                )
            formatted = format_results(results, n)
            return [types.TextContent(
                type='text',
                text=json.dumps({
                    'asset_type': asset_type,
                    'filter_applied': not filter_dropped,
                    'results': formatted,
                }, indent=2),
            )]
        except Exception as e:
            return [types.TextContent(type='text', text=f'Query error: {e}')]

    # ── kb_stats ──────────────────────────────────────────────────────────────
    elif name == 'kb_stats':
        try:
            count = collection.count()
            state_file = BASE_DIR / 'state.json'
            state = {}
            if state_file.exists():
                with open(state_file) as f:
                    state = json.load(f)
            stats = {
                'total_documents': count,
                'last_run':        state.get('last_run', 'never'),
                'total_ingested':  state.get('total_ingested', 0),
                'chroma_path':     str(CHROMA_DIR),
                'embed_model':     EMBED_MODEL,
            }
            return [types.TextContent(type='text', text=json.dumps(stats, indent=2))]
        except Exception as e:
            return [types.TextContent(type='text', text=f'Stats error: {e}')]

    return [types.TextContent(type='text', text=f'Unknown tool: {name}')]


# ─── Entry point ──────────────────────────────────────────────────────────────

async def main():
    async with stdio_server() as (read, write):
        await app.run(read, write, app.create_initialization_options())


if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
