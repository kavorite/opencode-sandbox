import json
import os
from mitmproxy import http

LOG = os.environ.get("MITMPROXY_LOG", "/var/log/mitmproxy/flows.jsonl")
_raw = os.environ.get("ALLOW_METHODS", "")
ALLOW_METHODS = [m.strip() for m in _raw.split(",") if m.strip()] if _raw else None


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
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def request(flow: http.HTTPFlow) -> None:
    if ALLOW_METHODS is not None and flow.request.method not in ALLOW_METHODS:
        flow.response = http.Response.make(403, b"Method not allowed by sandbox policy")
