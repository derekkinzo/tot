#!/usr/bin/env node

import { statusLines } from './status-report.js';

const USAGE = `tot-mcp [command]
  (default)  Start the per-session MCP server (stdio). One process per agent;
             the visualization dashboard URL is reported by the get_status tool.
  status     Show this project's central storage location and recent sessions
  --help     Show this message

Environment:
  TOT_DATA_DIR   Override the state root (default: $XDG_STATE_HOME/tot or ~/.tot)`;

const args = process.argv.slice(2);

if (args[0] === '--help' || args[0] === '-h') {
  console.log(USAGE);
} else if (args[0] === 'status') {
  for (const line of statusLines()) console.log(line);
} else if (args[0] === undefined) {
  import('./per-session.js').then(({ startServer }) => {
    startServer().catch((err) => {
      console.error('[tot-mcp] Fatal:', err);
      process.exit(1);
    });
  });
} else {
  console.error(`Unknown command: ${args[0]}. Use --help for usage.`);
  process.exit(1);
}
