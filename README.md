# opencode-sandbox

An opencode plugin that transparently intercepts bash commands, runs them inside a Docker container, and uses observed behavior to auto-allow clean commands or show a violation prompt for suspicious ones.

## Installation

```
npm install opencode-sandbox
```

Then add to your `opencode.json`:

```json
{
  "plugins": ["opencode-sandbox"]
}
```

## System Requirements

- Docker (Docker Engine or Docker Desktop)
- Docker daemon must be running

If Docker is unavailable, the plugin throws an error and blocks execution (does not fall through to the default permission flow).

## Configuration

Create `.opencode/sandbox.json` in your project root:

```json
{
  "network": {
    "observe": true,
    "allow_methods": ["GET", "HEAD", "OPTIONS"],
    "allow_graphql_queries": true
  },
  "filesystem": {
    "inherit_permissions": true,
    "allow_write": [],
    "deny_read": []
  },
  "auto_allow_clean": true,
  "verbose": false,
  "docker": {
    "image": "opencode-sandbox:local"
  }
}
```

All fields are optional. The values above are the defaults.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `network.observe` | boolean | `true` | Routes HTTP/HTTPS through mitmproxy to capture method, host, and TLS SNI. HTTP methods not in `allow_methods` are flagged as violations. Set to `false` to disable (not recommended). |
| `network.allow_methods` | string[] | `["GET","HEAD","OPTIONS"]` | HTTP methods allowed in observe mode. Others are flagged as violations. |
| `network.allow_graphql_queries` | boolean | `true` | Allow GraphQL POST requests even when POST is not in allow_methods (observe mode). |
| `filesystem.inherit_permissions` | boolean | `true` | Respect opencode's existing permission settings for file edits. |
| `filesystem.allow_write` | string[] | `[]` | Additional paths the sandbox considers safe to write to. |
| `filesystem.deny_read` | string[] | `[]` | Paths that should be flagged even for read access. |
| `auto_allow_clean` | boolean | `true` | When true, commands with no violations auto-approve without prompting. |
| `verbose` | boolean | `false` | Log sandbox results to console for debugging. |
| `docker.image` | string | `"opencode-sandbox:local"` | Custom Docker image to use as the sandbox base. |

## How It Works

1. When opencode runs a bash command, the plugin intercepts it via the `tool.execute.before` hook.
2. The command is run inside a warm Docker container via `docker exec`.
3. After execution, the container's filesystem overlay diff is inspected (`container.changes()`).
4. In observe mode, HTTP/HTTPS traffic is captured via a mitmproxy sidecar container.
5. A policy engine evaluates filesystem mutations and network activity against your config.
6. If clean and `auto_allow_clean` is true, the command auto-approves and the container state is committed.
7. If violations are found, the container is rolled back to the pre-command state and the permission prompt is shown with violation details.
8. The original command is replaced with a no-op — it already ran inside Docker.

## Network Observation

A mitmproxy sidecar container is started on the same Docker network. Sandbox containers route HTTP/HTTPS through it via `HTTP_PROXY`/`HTTPS_PROXY` environment variables. HTTP methods not in `allow_methods` (default: GET, HEAD, OPTIONS) are flagged as violations. GraphQL POST requests carrying read-only queries are allowed when `allow_graphql_queries` is true.

### What It Captures

| Field | Type | Description |
|-------|------|-------------|
| `result.http` | `HttpRequest[]` | HTTP method, path, host, port |
| `result.tls` | `TlsInfo[]` | TLS SNI hostname and port |

**Note**: DNS is not directly observable via explicit proxy mode. Programs that hardcode connections (bypassing HTTP_PROXY) are not intercepted.

## What Gets Flagged

| Behavior | Severity |
|----------|----------|
| HTTP methods not in allow_methods (observe mode) | high |
| Filesystem mutations outside the project directory | medium |
| Reads of denied paths | medium |

## Limitations

- **Docker required.** If Docker is not running, the plugin errors and blocks.
- **Not escape-proof.** This is an observation tool, not a security boundary.
- **Programs ignoring HTTP_PROXY.** Applications with hardcoded connections bypass mitmproxy (observe mode).
- **Cert pinning.** Applications using certificate pinning are impervious to MITM (observe mode).
- **Project-dir writes are irrevocable.** The project directory is bind-mounted directly — writes go to the host immediately and are not rolled back on rejection (only out-of-project container writes are rolled back).
- **Container startup latency.** First command in a session incurs container startup time (~500ms on Linux).
