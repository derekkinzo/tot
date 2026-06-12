# tot-mcp (server)

The MCP server package for [tot-mcp](https://github.com/derekkinzo/tot) — structured hypothesis tree reasoning for AI agents.

For installation, usage, architecture, and research background see the
[top-level README](../../README.md).

## Package layout

- `src/cli.ts` — entry point; dispatches between the MCP shim, the daemon, and CLI subcommands (`status`, `stop`, `serve`)
- `src/shim.ts` — stdio MCP transport that forwards calls to the daemon over TCP
- `src/daemon.ts` — long-lived process that owns tree state, serves the dashboard, and accepts multiple shim connections
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

Vitest covers the tree manager, persistence (JSONL roundtrips), the daemon
integration surface, and plugin structure (skills, agents, hooks,
`.mcp.json`).

## License

MIT
