# opencode-sandbox

An opencode plugin that transparently intercepts bash commands, runs them in a lightweight Linux sandbox (bwrap + strace), and uses observed behavior to auto-allow clean commands or enrich the permission prompt with forensic details for suspicious ones. All within 250ms.

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

- Linux (required — uses Linux namespaces)
- bubblewrap (`apt install bubblewrap` / `pacman -S bubblewrap`)
- strace (`apt install strace` / `pacman -S strace`)

If either dependency is missing, the plugin warns once and falls through to the normal permission flow. No commands are blocked.

## Configuration

Create `.opencode/sandbox.json` in your project root:

```json
{
  "timeout": 250,
  "network": {
    "mode": "block",
    "allow": []
  },
  "filesystem": {
    "inherit_permissions": true,
    "allow_write": [],
    "deny_read": []
  },
  "auto_allow_clean": true,
  "verbose": false
}
```

All fields are optional. The values above are the defaults.

| Field                            | Type        | Default   | Description                                                                                                       |
| -------------------------------- | ----------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `timeout`                        | number (ms) | `250`     | How long to wait for the sandbox to complete. Commands exceeding this fall through to the normal permission flow. |
| `network.mode`                   | string      | `"block"` | `"block"` blocks all network access. `"observe"` captures HTTP method, TLS SNI, and DNS queries via the `oc-observe` supervisor (Linux ≥ 5.14, requires C compiler at install time). `"log"` is reserved for future use. |
| `network.allow`                  | string[]    | `[]`      | IP addresses that are allowed and won't be flagged as violations.                                                 |
| `network.allow_methods`          | string[]    | undefined | HTTP methods to allow through the TLS MITM proxy. When set with `mode: "observe"`, activates proxy mode.         |
| `filesystem.inherit_permissions` | boolean     | `true`    | Whether to respect opencode's existing permission settings.                                                       |
| `filesystem.allow_write`         | string[]    | `[]`      | Additional paths the sandbox considers safe to write to.                                                          |
| `filesystem.deny_read`           | string[]    | `[]`      | Paths that should be flagged even for read access.                                                                |
| `auto_allow_clean`               | boolean     | `true`    | When true, commands with no violations auto-approve without prompting.                                            |
| `home_readable`                  | boolean     | `true`    | Mount `$HOME` read-only so programs can access configs, SSH keys, and dotfiles. When `false`, `$HOME` is an empty tmpfs and only the project directory is re-mounted. |
| `verbose`                        | boolean     | `false`   | Log sandbox results to console for debugging.                                                                     |

## How It Works

1. When opencode runs a bash command, the plugin intercepts it via the `tool.execute.before` hook.
2. The command is re-executed inside a bwrap sandbox with a read-only filesystem overlay, isolated network, and isolated PID namespace. strace observes all syscalls.
3. strace output is parsed for: file opens, file writes, filesystem mutations (mkdir, unlink, rename), and network connections (TCP, UDP, Unix sockets).
4. A policy engine evaluates the observations against your config.
5. If clean and `auto_allow_clean` is true, the command auto-approves.
6. If violations are found, the permission prompt is enriched with a forensic report.
7. If the command doesn't finish within `timeout`, it falls through to the normal permission flow.

## Protocol Detection (observe mode)

When `network.mode` is set to `"observe"`, the sandbox runs a native C supervisor (`oc-observe`) alongside strace. The supervisor intercepts `connect()` calls via Linux seccomp `USER_NOTIF`, injects an `AF_UNIX` socketpair so the process gets a connection, reads the first bytes the process sends, and outputs structured JSON to stdout.

### What It Captures

| Field         | Type          | Description                                      |
| ------------- | ------------- | ------------------------------------------------ |
| `result.http` | `HttpRequest[]` | HTTP method, path, host, destination IP and port |
| `result.tls`  | `TlsInfo[]`   | TLS SNI hostname, destination IP and port        |
| `result.dns`  | `DnsQuery[]`  | DNS query name, query type, resolver IP          |

### System Requirements

- Linux kernel ≥ 5.14 (seccomp `SECCOMP_IOCTL_NOTIF_ADDFD` support)
- A C compiler (`cc`) available at `npm install` time (the postinstall script compiles `src/observe.c`)
- bubblewrap and strace (same as base requirements)

If the `oc-observe` binary is not compiled (e.g., no C compiler at install time), the plugin warns once and falls back to block mode. No crash occurs.

### How to Enable

```json
{
  "network": {
    "mode": "observe",
    "allow": []
  }
}
```

### Example Output

```json
{
  "http": [{ "method": "GET", "path": "/", "host": "example.com", "addr": "93.184.216.34", "port": 80 }],
  "tls": [{ "sni": "api.github.com", "addr": "140.82.121.5", "port": 443 }],
  "dns": [{ "qname": "example.com", "qtype": "A", "resolver": "8.8.8.8" }]
}
```

## TLS MITM Proxy (Phase 3)

When `network.mode` is set to `"observe"` and `network.allow_methods` is configured, the sandbox activates TLS MITM proxy mode. This allows selective HTTP method filtering while transparently proxying HTTPS traffic.

### How It Works

1. A CA certificate is auto-generated on first use and stored in `bin/ca-gen`.
2. The CA certificate is injected into the sandbox via bwrap bind-mounts to system CA paths and environment variables.
3. HTTP requests are intercepted and filtered by method. Allowed methods are proxied; disallowed methods receive a 403 response.
4. Non-HTTP TLS connections are blocked entirely.

### Configuration

```json
{
  "network": {
    "mode": "observe",
    "allow_methods": ["GET"]
  }
}
```

### Trust Injection

The CA certificate is injected into the sandbox via:
- bwrap bind-mounts to 4 distro CA paths: `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/cert.pem`, `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`
- Environment variables: `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`

### HTTP Method Filtering

Only HTTP methods listed in `allow_methods` are proxied. Requests using other methods receive a 403 Forbidden response. This allows fine-grained control over which operations are permitted.

## What Gets Flagged

| Behavior                                           | Severity |
| -------------------------------------------------- | -------- |
| Network connections (TCP/UDP)                      | high     |
| Filesystem mutations outside the project directory | medium   |
| Reads of denied paths                              | medium   |
| Unix domain socket connections                     | low      |

## Limitations

- **Linux only.** Uses Linux namespaces (bwrap), which aren't available on macOS or Windows.
- **Not escape-proof.** This is an observation tool, not a security boundary. A determined attacker could bypass bwrap.
- **io_uring blind spot.** Syscalls made via io_uring are not observed by strace.
- **Static binary observation.** strace observes syscalls; statically linked binaries that don't use libc may behave differently.
- **250ms budget.** Commands that inherently take longer (large builds, network-dependent operations) will always fall through to the normal permission flow.
- **Unix sockets.** `--unshare-net` doesn't block AF_UNIX sockets. The plugin mitigates this with `--tmpfs /run`, but some socket paths may still be accessible.
- **observe mode: kernel ≥ 5.14.** The `oc-observe` supervisor requires `SECCOMP_IOCTL_NOTIF_ADDFD`, available since Linux 5.14. Older kernels fall back to block mode.
- **observe mode: C compiler required at install.** The `oc-observe` binary is compiled from source during `npm install`. If no C compiler is available, observe mode is silently disabled.
- **observe mode: first-packet only.** Protocol detection reads only the first bytes sent by the process. Subsequent packets in the same connection are not inspected.
- **Cert pinning.** Applications using certificate pinning (e.g., Rust with webpki-roots, NSS-based programs) are impervious to CA injection and will fail to connect through the proxy.
- **proxy mode: NSS-based programs.** Firefox, Chrome use cert9.db, not PEM files — CA injection does not work for them.
