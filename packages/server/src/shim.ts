/**
 * The thin MCP stdio proxy (shim).
 * Discovers/starts the GLOBAL daemon, connects via TCP IPC, and proxies MCP tool calls.
 */

import { createConnection, type Socket } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { v4 as uuid } from 'uuid';
import { getTotDir, discoverDaemon, startDaemon } from './daemon-lifecycle.js';
import { encode, createLineParser, type ShimToDaemon, type DaemonToShim } from './ipc-protocol.js';
import { TOOL_SCHEMAS } from './tools.js';
import { registerPrompts } from './prompts.js';

export async function startShim(): Promise<void> {
  const totDir = getTotDir();

  // Discover or start global daemon
  let daemonInfo = discoverDaemon(totDir);
  if (!daemonInfo) {
    console.error('[tot-shim] Starting global daemon...');
    daemonInfo = await startDaemon(totDir);
    console.error(`[tot-shim] Daemon started (PID ${daemonInfo.pid}, IPC port ${daemonInfo.ipcPort})`);
  } else {
    console.error(`[tot-shim] Connected to existing daemon (PID ${daemonInfo.pid})`);
  }

  // Connect TCP to daemon
  const socket = await connectToDaemon(daemonInfo.ipcPort);

  // Send handshake with this project's directory
  const projectDir = process.env['CLAUDE_PROJECT_DIR'] || process.cwd();
  const handshake: ShimToDaemon = { type: 'handshake', projectDir };
  socket.write(encode(handshake));

  // Pending tool-call response map (id → { resolve, reject, timer })
  const pending = new Map<string, {
    resolve: (result: { content: Array<{ type: 'text'; text: string }>; isError: boolean }) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Parse incoming daemon messages
  const VALID_DAEMON_TYPES = new Set(['handshake-ack', 'tool-result', 'error']);
  const parser = createLineParser((msg: DaemonToShim) => {
    if (!msg.type || !VALID_DAEMON_TYPES.has(msg.type)) {
      console.error(`[tot-shim] Warning: unknown daemon message type "${msg.type}"`);
      return;
    }
    switch (msg.type) {
      case 'handshake-ack':
        console.error(`[tot-shim] Handshake confirmed. HTTP: http://localhost:${msg.httpPort}`);
        break;
      case 'tool-result': {
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve({ content: msg.content, isError: msg.isError });
        }
        break;
      }
      case 'error':
        console.error(`[tot-shim] Daemon error: ${msg.message}`);
        break;
    }
  });

  socket.on('data', parser);

  // Create MCP server
  const server = new McpServer({
    name: 'tot-mcp',
    version: '0.1.0',
  });

  // Register all tools as proxy handlers
  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    server.tool(name, schema.description, schema.schema, async (args: any) => {
      const id = uuid();
      const callMsg: ShimToDaemon = { type: 'tool-call', id, tool: name, args };
      socket.write(encode(callMsg));

      // Wait for daemon response (with timeout)
      const result = await new Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`Tool call '${name}' timed out`));
          }
        }, 30000);
        pending.set(id, { resolve, reject, timer });
      });

      return result;
    });
  }

  // Register prompts (static templates, no daemon round-trip needed)
  registerPrompts(server);

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdin end/close → disconnect + exit
  process.stdin.on('end', () => {
    console.error('[tot-shim] Client disconnected (stdin closed), shutting down');
    sendDisconnect(socket);
    process.exit(0);
  });
  process.stdin.on('close', () => {
    console.error('[tot-shim] stdin closed, shutting down');
    sendDisconnect(socket);
    process.exit(0);
  });
  process.on('SIGPIPE', () => {
    sendDisconnect(socket);
    process.exit(0);
  });

  // Socket error/close → reject all pending, then exit
  function rejectAllPending(reason: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  socket.on('close', () => {
    console.error('[tot-shim] Daemon connection closed');
    rejectAllPending('Daemon connection closed');
    server.close().finally(() => process.exit(1));
  });
  socket.on('error', (err) => {
    console.error(`[tot-shim] Daemon connection error: ${err.message}`);
    rejectAllPending(`Daemon error: ${err.message}`);
    server.close().finally(() => process.exit(1));
  });

  // Graceful shutdown on signals
  process.on('SIGTERM', () => {
    sendDisconnect(socket);
    process.exit(0);
  });
  process.on('SIGINT', () => {
    sendDisconnect(socket);
    process.exit(0);
  });
}

function connectToDaemon(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      resolve(socket);
    });
    socket.on('error', (err) => {
      reject(new Error(`Failed to connect to daemon on port ${port}: ${err.message}`));
    });
  });
}

function sendDisconnect(socket: Socket): void {
  try {
    const msg: ShimToDaemon = { type: 'disconnect' };
    socket.write(encode(msg));
  } catch {
    // Socket may already be closed
  }
}
