# tot-mcp (server)

The MCP server package for [tot-mcp](https://github.com/derekkinzo/tot) — structured hypothesis tree reasoning for AI agents.

For installation, usage, architecture, and research background see the
[project README on GitHub](https://github.com/derekkinzo/tot#readme).

## Package layout

- `src/cli.ts` — entry point; starts the per-session server by default, plus the `status` subcommand
- `src/per-session.ts` — the in-process server: one TreeManager, an MCP stdio transport, and an ephemeral-port HTTP dashboard, all living as long as the stdio connection
- `src/http.ts` — HTTP visualization server (SSE stream + JSON state API)
- `src/sse-hub.ts` — SSE client lifecycle (subscription, broadcast, keepalive)
- `src/central-storage.ts` / `src/storage-paths.ts` — central per-project journal layout under the state root
- `src/tree-manager.ts` — in-memory tree model and mutators
- `src/persistence.ts` — append-only JSONL session journal
- `src/responses.ts` — formats MCP tool responses with structural advisories
- `static/` — bundled web UI (copied from `../web-ui/dist` by the build)
- `dist/` — build output (executable `cli.js` with shebang)

## Build

```bash
npm install
npm run build
```

`npm run build` runs `tsup` (ESM bundling), emits TypeScript declarations,
and copies the web UI into `static/`. The build emits `dist/cli.js` which
is the entry point referenced by `.mcp.json` and the plugin's SessionStart
install hook.

## Tests

```bash
npm test
```

Vitest covers the tree manager, persistence (JSONL roundtrips), the MCP
integration surface, the per-session server (ephemeral port, central
storage, reload-from-disk, legacy migration), and plugin structure (skills,
agents, hooks, `.mcp.json`).

## License

MIT
