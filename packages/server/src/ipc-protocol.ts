/**
 * IPC protocol types and framing helpers for shim↔daemon NDJSON communication.
 */
import { StringDecoder } from 'node:string_decoder';

/**
 * Upper bound on a single un-terminated line. A peer that streams data with no
 * newline would otherwise grow the parse buffer without limit; past this cap
 * the buffer is dropped and the malformed input reported.
 */
const MAX_LINE_BYTES = 1 << 20; // 1 MiB

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
  // StringDecoder holds an incomplete trailing multibyte sequence across
  // writes, so a UTF-8 codepoint split over two TCP chunks decodes correctly
  // instead of becoming replacement characters.
  const decoder = new StringDecoder('utf8');
  return (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
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
    // A runaway peer that never sends a newline must not grow the buffer
    // without bound; drop it past the cap rather than risk OOM.
    if (buffer.length > MAX_LINE_BYTES) {
      console.error('[tot-ipc] Dropping oversized line with no delimiter');
      buffer = '';
    }
  };
}
