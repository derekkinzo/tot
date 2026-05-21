/**
 * IPC protocol types and framing helpers for shim↔daemon NDJSON communication.
 */

// ─── Shim → Daemon messages ───

export interface HandshakeMsg {
  type: 'handshake';
  projectDir: string;
}

export interface ToolCallMsg {
  type: 'tool-call';
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface DisconnectMsg {
  type: 'disconnect';
}

export type ShimToDaemon = HandshakeMsg | ToolCallMsg | DisconnectMsg;

// ─── Daemon → Shim messages ───

export interface HandshakeAckMsg {
  type: 'handshake-ack';
  httpPort: number;
}

export interface ToolResultMsg {
  type: 'tool-result';
  id: string;
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

export interface ErrorMsg {
  type: 'error';
  message: string;
}

export type DaemonToShim = HandshakeAckMsg | ToolResultMsg | ErrorMsg;

// ─── Framing helpers ───

export function encode(msg: ShimToDaemon | DaemonToShim): string {
  return JSON.stringify(msg) + '\n';
}

export function createLineParser(onMessage: (msg: any) => void): (chunk: Buffer | string) => void {
  let buffer = '';
  return (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        console.error('[tot-ipc] Malformed message:', line.slice(0, 100));
      }
    }
  };
}
