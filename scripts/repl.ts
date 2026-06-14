#!/usr/bin/env npx tsx
/**
 * Interactive REPL for tot-mcp server
 *
 * Starts the server and gives you a command prompt to call tools manually.
 * The browser visualization updates in real-time as you issue commands.
 *
 * Usage: npx tsx scripts/repl.ts
 * Then open: http://localhost:6274
 *
 * Commands:
 *   create <problem>              - Create a new tree
 *   decompose <id> <child1> | <child2> | ...   - Decompose into children
 *   evidence <id> supports|refutes|neutral <content>  - Add evidence
 *   eliminate <id> <reason>       - Eliminate hypothesis (refuted)
 *   corroborate <id> <reason>     - Mark hypothesis as corroborated (provisionally retained)
 *   oos <id> <reason>             - Set hypothesis out-of-scope (terminal, no refutation)
 *   add <parentId> <content>     - Add single hypothesis
 *   tree                          - Show tree (compact)
 *   status                        - Show status
 *   validate <id>                 - Validate decomposition
 *   help                          - Show commands
 *   quit                          - Exit
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const SERVER_PATH = join(process.cwd(), 'packages/server/dist/cli.js');
let verbose = false; // Toggle with 'verbose' command

// Clean previous REPL state
rmSync(join(process.cwd(), '.tot-repl'), { recursive: true, force: true });

// Start server (shim → daemon chain)
const GLOBAL_DIR = join(process.cwd(), '.tot-repl');
const server = spawn('node', [SERVER_PATH], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CLAUDE_PROJECT_DIR: process.cwd(),
    TOT_GLOBAL_DIR: GLOBAL_DIR,
    TOT_PORT: '6274',
    TOT_IDLE_TIMEOUT: '300000', // 5min for REPL testing
  },
});

let buffer = '';
let nextId = 1;
const pending = new Map<number, (resp: any) => void>();
let currentRootId: string | null = null;
let lastChildIds: string[] = [];
// Every full ID the server has handed back this session. Lets the user type a
// short unique prefix (the form the REPL prints) and resolve it to the full
// UUID the server's exact-match lookup requires.
const knownIds = new Set<string>();

function remember(...ids: (string | undefined | null)[]): void {
  for (const id of ids) if (id) knownIds.add(id);
}

server.stdout?.on('data', (data: Buffer) => {
  buffer += data.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if ('id' in msg && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

server.stderr?.on('data', (data: Buffer) => {
  const text = data.toString().trim();
  if (text) console.log(`  [server] ${text}`);
});

async function send(method: string, params: any): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Timeout')); }, 10000);
    pending.set(id, (resp) => { clearTimeout(timeout); resolve(resp); });
    server.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function callTool(name: string, args: Record<string, any>): Promise<{ text: string; data: any; isError: boolean }> {
  if (verbose) console.log(`\n  ──── SENT ────\n  tool: ${name}\n  args: ${JSON.stringify(args)}`);
  const resp = await send('tools/call', { name, arguments: args });
  const content = resp.result?.content;
  const text = content?.find((c: any) => c.type === 'text')?.text || '';
  if (verbose) console.log(`  ──── RECEIVED ────\n${text}\n  ────────────────`);
  const firstLine = text.split('\n')[0];
  let data: any = null;
  try { data = JSON.parse(firstLine); } catch {}
  return { text, data, isError: resp.result?.isError || false };
}

// Initialize
async function init() {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'repl', version: '1.0' },
  });
  server.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

// Command handlers
async function handleCommand(input: string) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  if (!cmd) return;

  try {
    switch (cmd) {
      case 'create': {
        const problem = parts.slice(1).join(' ') || 'Debug this issue';
        const result = await callTool('create_tree', { problem });
        if (result.isError) { console.log(`  Error: ${result.text}`); break; }
        currentRootId = result.data?.rootId;
        remember(currentRootId);
        console.log(`  ✓ Tree created`);
        console.log(`    Session: ${result.data?.sessionId?.slice(0, 8)}`);
        console.log(`    Root ID: ${currentRootId?.slice(0, 8)}`);
        console.log(`    (decompose with "." for root, or this short ID)`);
        break;
      }
      case 'decompose': case 'd': {
        const id = resolveId(parts[1]);
        if (!id) { console.log('  Usage: decompose <id|.|0|1...> <child1> | <child2> | ...'); break; }
        const childrenStr = parts.slice(2).join(' ');
        const children = childrenStr.split('|').map(s => s.trim()).filter(Boolean);
        if (children.length < 2) { console.log('  Need at least 2 children separated by |'); break; }
        const result = await callTool('decompose', { parentId: id, children });
        if (result.isError) { console.log(`  Error: ${result.text}`); break; }
        lastChildIds = result.data?.childIds || [];
        remember(...lastChildIds);
        console.log(`  ✓ Decomposed into ${lastChildIds.length} children:`);
        lastChildIds.forEach((cid, i) => console.log(`    [${i}] ${cid.slice(0, 8)}  "${children[i]}"`));
        break;
      }
      case 'evidence': case 'ev': {
        const id = resolveId(parts[1]);
        if (!id) { console.log('  Usage: evidence <id|0|1|2...> supports|refutes|neutral <content>'); break; }
        const type = parts[2] as 'supports' | 'refutes' | 'neutral';
        if (!['supports', 'refutes', 'neutral'].includes(type)) {
          console.log('  Type must be: supports, refutes, or neutral'); break;
        }
        const content = parts.slice(3).join(' ');
        const result = await callTool('add_evidence', { hypothesisId: id, type, content });
        if (result.isError) { console.log(`  Error: ${result.text}`); break; }
        console.log(`  ✓ Evidence (${type}) added`);
        break;
      }
      case 'eliminate': case 'elim': {
        const id = resolveId(parts[1]);
        if (!id) { console.log('  Usage: eliminate <id|0|1|2...> <reason>'); break; }
        const reason = parts.slice(2).join(' ') || 'Eliminated';
        const result = await callTool('eliminate_hypothesis', { hypothesisId: id, reason });
        if (result.isError) { console.log(`  Error: ${result.text}`); break; }
        console.log(`  ✓ Eliminated`);
        break;
      }
      case 'corroborate': case 'confirm': {
        const id = resolveId(parts[1]);
        if (!id) { console.log('  Usage: corroborate <id|0|1|2...> <reason>'); break; }
        const reason = parts.slice(2).join(' ') || 'Corroborated';
        const result = await callTool('corroborate_hypothesis', { hypothesisId: id, reason });
        if (result.isError) { console.log(`  Error: ${result.text}`); break; }
        console.log(`  ✓ Corroborated`);
        break;
      }
      case 'oos': case 'out-of-scope': {
        const id = resolveId(parts[1]);
        if (!id) { console.log('  Usage: oos <id|0|1|2...> <reason>'); break; }
        const reason = parts.slice(2).join(' ') || 'Set aside';
        const result = await callTool('set_out_of_scope', { hypothesisId: id, reason });
        if (result.isError) { console.log(`  Error: ${result.text}`); break; }
        console.log(`  ✓ Out of scope`);
        break;
      }
      case 'add': {
        const parentId = resolveId(parts[1]);
        if (!parentId) { console.log('  Usage: add <parentId|.|0|1...> <content>'); break; }
        const content = parts.slice(2).join(' ');
        const result = await callTool('add_hypothesis', { parentId, content });
        if (result.isError) { console.log(`  Error: ${result.text}`); break; }
        remember(result.data?.hypothesisId);
        console.log(`  ✓ Added: ${result.data?.hypothesisId?.slice(0, 8)}`);
        break;
      }
      case 'tree': case 't': {
        const format = parts[1] || 'compact';
        const result = await callTool('get_tree', { format });
        if (result.isError) { console.log(`  Error: ${result.text}`); break; }
        console.log(result.text);
        break;
      }
      case 'status': case 's': {
        const result = await callTool('get_status', {});
        console.log(result.text);
        break;
      }
      case 'validate': case 'v': {
        // No argument defaults to the root; an explicit but unresolvable token
        // bails rather than silently validating the root in its place.
        const id = parts[1] ? resolveId(parts[1]) : currentRootId;
        if (!id) { console.log('  Usage: validate <id|.>'); break; }
        const result = await callTool('validate_decomposition', { parentId: id });
        console.log(result.text);
        break;
      }
      case 'ids': {
        console.log(`  Root: ${currentRootId?.slice(0, 8) || 'none'}`);
        console.log(`  Last children:`);
        lastChildIds.forEach((id, i) => console.log(`    [${i}] ${id.slice(0, 8)}`));
        break;
      }
      case 'verbose': case 'vv': {
        verbose = !verbose;
        console.log(`  Verbose mode: ${verbose ? 'ON (showing full send/receive)' : 'OFF'}`);
        break;
      }
      case 'help': case 'h': case '?': {
        console.log(`
  Commands (use . for root, 0/1/2... for last decompose children):
    create <problem>                    - Create new tree
    decompose <id|.> A | B | C          - MECE decompose (pipe-separated)
    evidence <id|0> supports <text>     - Add evidence
    eliminate <id|0> <reason>           - Eliminate hypothesis (refuted)
    corroborate <id|0> <reason>         - Mark hypothesis as corroborated
    oos <id|0> <reason>                 - Set hypothesis out-of-scope
    add <id|.> <content>                - Add single hypothesis
    tree [full|compact]                 - Show tree
    status                              - Show progress
    validate <id|.>                     - Check MECE structure
    ids                                 - Show stored IDs
    verbose                             - Toggle full send/receive display
    quit                                - Exit
`);
        break;
      }
      case 'quit': case 'q': case 'exit': {
        server.stdin?.end();
        process.exit(0);
      }
      default:
        console.log(`  Unknown command: ${cmd}. Type 'help' for commands.`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }
}

function resolveId(input: string | undefined): string | null {
  if (!input) return null;
  if (input === '.') return currentRootId;
  // A bare index (0,1,2...) selects from the most recent decompose's children.
  // Reserve this only for short, purely-numeric tokens — a full UUID can start
  // with digits but is never a 1-2 digit integer. Out of range falls through
  // to prefix matching, so an all-digit ID prefix can still resolve.
  if (/^\d{1,2}$/.test(input)) {
    const idx = parseInt(input, 10);
    if (idx >= 0 && idx < lastChildIds.length) return lastChildIds[idx];
  }
  // Exact match wins outright.
  if (knownIds.has(input)) return input;
  // Treat the token as a prefix of a known ID (the short form the REPL prints).
  // Unique prefix → resolved; ambiguous → rejected so the user sees a clear
  // message instead of a silent server error.
  const matches = Array.from(knownIds).filter((id) => id.startsWith(input));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.log(`  Ambiguous ID "${input}" matches ${matches.length} hypotheses — type more characters.`);
    return null;
  }
  // An ID-shaped token the REPL never captured (a short prefix copied from the
  // dashboard, or a full UUID from another session) is forwarded to the server
  // for an authoritative exact-match lookup rather than rejected here.
  if (/^[0-9a-f-]{8,}$/i.test(input)) return input;
  return null;
}

// Main
async function main() {
  await init();
  await new Promise(r => setTimeout(r, 500));

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   tot-mcp Interactive REPL                    ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║   Browser: http://localhost:6274              ║');
  console.log('║   Type "help" for commands                   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'tot> ' });
  rl.prompt();

  rl.on('line', async (line) => {
    await handleCommand(line);
    rl.prompt();
  });

  rl.on('close', () => {
    server.stdin?.end();
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
