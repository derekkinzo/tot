#!/usr/bin/env node

import { getTotDir, stopDaemon, discoverDaemon } from './daemon-lifecycle.js';
import { scanSessions } from './persistence.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const USAGE = `tot-mcp [command]
  (default)  Start MCP shim
  serve      Start global daemon (foreground)
  status     Show daemon and registered project info
  stop       Stop running daemon
  --help     Show this message`;

const args = process.argv.slice(2);

if (args[0] === '--help' || args[0] === '-h') {
  console.log(USAGE);
} else if (args[0] === 'status') {
  printStatus();
} else if (args[0] === 'stop') {
  const totDir = getTotDir();
  const stopped = stopDaemon(totDir);
  if (stopped) {
    console.log('Daemon stopped.');
  } else {
    console.log('No running daemon found.');
  }
} else if (args[0] === 'serve') {
  // Start daemon directly (foreground) — useful for offline viewing
  import('./daemon.js');
} else if (args[0] === undefined) {
  // Default: start the shim (MCP stdio proxy)
  import('./shim.js').then(({ startShim }) => {
    startShim().catch((err) => {
      console.error('[tot-mcp] Fatal:', err);
      process.exit(1);
    });
  });
} else {
  console.error(`Unknown command: ${args[0]}. Use --help for usage.`);
  process.exit(1);
}

function printStatus(): void {
  const totDir = getTotDir();
  const daemonInfo = discoverDaemon(totDir);

  console.log(`Global state dir: ${totDir}`);
  console.log('');

  if (daemonInfo) {
    console.log(`Daemon: running (PID ${daemonInfo.pid}, IPC port ${daemonInfo.ipcPort}, HTTP port ${daemonInfo.httpPort})`);
    console.log(`  Visualization: http://localhost:${daemonInfo.httpPort}`);
  } else {
    console.log('Daemon: not running');
  }

  // Show current project's sessions (if in a project)
  const projectDir = process.env['CLAUDE_PROJECT_DIR'] || process.cwd();
  const dataDir = join(projectDir, '.tot', 'sessions');

  console.log('');
  console.log(`Current project: ${projectDir}`);

  if (existsSync(dataDir)) {
    const sessions = scanSessions(dataDir);
    if (sessions.length === 0) {
      console.log('  No sessions.');
    } else {
      console.log(`  Sessions: ${sessions.length}`);
      const sorted = [...sessions].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      for (const s of sorted.slice(0, 5)) {
        const statusIcon = s.status === 'open' ? '*' : s.status === 'resolved' ? '+' : '-';
        console.log(`  [${statusIcon}] ${s.id.slice(0, 8)} "${s.problem.slice(0, 50)}" (${s.nodeCount} nodes)`);
      }
      if (sorted.length > 5) {
        console.log(`  ... and ${sorted.length - 5} more`);
      }
    }
  } else {
    console.log('  No .tot/sessions/ directory.');
  }
}
