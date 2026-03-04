import json
import os
import re
from mitmproxy import http

LOG = os.environ.get("MITMPROXY_LOG", "/var/log/mitmproxy/flows.jsonl")
_raw = os.environ.get("ALLOW_METHODS", "")
ALLOW_METHODS = [m.strip() for m in _raw.split(",") if m.strip()] if _raw else None
ALLOW_GRAPHQL = os.environ.get("ALLOW_GRAPHQL_QUERIES", "true").lower() == "true"

# Matches the first significant token in a GraphQL document after stripping comments.
_OP_RE = re.compile(r"\s*(query|mutation|subscription)\b")
_ANON_QUERY_RE = re.compile(r"\s*\{")


def _is_graphql_endpoint(path: str) -> bool:
    return "graphql" in path.lower()


def _extract_graphql_operation(body: bytes) -> str | None:
    """Extract GraphQL operation type from a JSON request body.

    Returns 'query', 'mutation', 'subscription', or None.
    The operation keyword is always the first significant token in a
    GraphQL document, so a single-pass regex after comment stripping
    is reliable here.
    """
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None

    query_str = data.get("query", "")
    if not isinstance(query_str, str) or not query_str.strip():
        return None

    # Strip single-line comments (# to end of line)
    cleaned = re.sub(r"#[^\n]*", "", query_str)

    m = _OP_RE.match(cleaned)
    if m:
        return m.group(1)

    # Anonymous query shorthand: document starts with `{`
    if _ANON_QUERY_RE.match(cleaned):
        return "query"

    return None


def response(flow: http.HTTPFlow) -> None:
    entry = {
        "method": flow.request.method,
        "path": flow.request.path,
        "host": flow.request.host,
        "port": flow.request.port,
        "status": flow.response.status_code if flow.response else None,
        "tls": flow.request.scheme == "https",
        "sni": getattr(flow.client_conn, "sni", None),
    }

    # Capture request body for GraphQL POSTs so the TypeScript policy engine
    # can do full AST-level parsing with the graphql reference parser.
    if flow.request.method == "POST" and _is_graphql_endpoint(flow.request.path):
        body = flow.request.get_text()
        if body:
            entry["body"] = body

    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def request(flow: http.HTTPFlow) -> None:
    if ALLOW_METHODS is not None and flow.request.method not in ALLOW_METHODS:
        if (
            ALLOW_GRAPHQL
            and flow.request.method == "POST"
            and _is_graphql_endpoint(flow.request.path)
        ):
            op = _extract_graphql_operation(flow.request.content)
            # Only allow queries through — mutations and subscriptions are flagged
            if op == "query":
                return
        flow.response = http.Response.make(403, b"Method not allowed by sandbox policy")
