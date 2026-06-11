# Daemon Architecture Design

## Overview

tot-mcp uses a client-server (daemon) architecture:
- **Shim** (spawned by MCP client): thin stdio proxy that forwards to daemon
- **Daemon** (long-lived): owns tree state, serves HTTP/SSE, accepts multiple shim connections

## Why Daemon (Not Per-Process)

| Problem | Per-Process | Daemon |
|---------|-------------|--------|
| Port conflicts | Multiple ports, user confusion | One stable port |
| Concurrent client visibility | Separate state, can't share | Shared state |
| Browser dies on agent exit | Yes | No (daemon outlives agents) |
| Offline viewing | Impossible | Daemon serves persisted state |
| PID management | Complex, buggy | Trivial (one daemon) |

## File Layout

```
.tot/
├── .gitignore          # "*"
├── daemon.port         # IPC TCP port (e.g., "48721")
├── daemon.pid          # Daemon process ID
├── daemon.http         # HTTP port for web UI (e.g., "6274")
└── sessions/
    └── {session-id}.jsonl
```

## IPC Protocol

NDJSON over TCP (newline-delimited JSON). Messages:

```typescript
// Shim → Daemon
| { type: 'handshake', version: 1, projectDir: string }
| { type: 'tool-call', id: string, toolName: string, args: Record<string, unknown> }
| { type: 'prompt-list', id: string }
| { type: 'prompt-get', id: string, name: string, args: Record<string, string> }
| { type: 'disconnect' }

// Daemon → Shim
| { type: 'handshake-ack', ok: boolean, error?: string }
| { type: 'tool-result', id: string, content: [...], isError: boolean }
| { type: 'prompt-list-result', id: string, prompts: [...] }
| { type: 'prompt-get-result', id: string, messages: [...] }
```

## Lifecycle

1. MCP client spawns `node cli.js` (the shim)
2. Shim checks `.tot/daemon.port` → TCP probe
3. If daemon running: connect, handshake, proxy tool calls
4. If not running: fork daemon (detached), poll for port file, connect
5. When shim stdin closes: send disconnect, exit
6. Daemon idle timer: 30min with no shim connections → exit
7. Daemon cleans up port/pid files on exit

## Implementation Modules

| File | Lines | Purpose |
|------|-------|---------|
| `ipc-protocol.ts` | ~55 | Message types + NDJSON framing |
| `daemon-lifecycle.ts` | ~95 | Discover/start/stop daemon |
| `shim.ts` | ~110 | MCP stdio proxy |
| `daemon.ts` | ~120 | Long-lived server process |
| `cli.ts` (modified) | ~10 | Route to shim by default |
| `tools.ts` (refactor) | ~30 | Extract `getToolHandlers()` |

Total: ~405 lines new/changed code.
