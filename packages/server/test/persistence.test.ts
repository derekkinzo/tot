import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TreeManager } from '../src/tree-manager.js';
import { registerTools } from '../src/tools.js';
import { loadActiveSessions } from '../src/persistence.js';

function parseResult(result: any): any {
  const text = result.content?.find((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text.split('\n')[0]); } catch { return { raw: text }; }
}

describe('Persistence Roundtrip', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tot-persist-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createServerWithClient(dataDir: string) {
    const tm = new TreeManager({ stagnationThreshold: 4 });
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerTools(server, tm, () => dataDir);
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    return { tm, server, client, cleanup: () => client.close() };
  }

  it('tree state survives server restart', async () => {
    // Session 1: create tree and add data
    const { client: c1, cleanup: cleanup1 } = await createServerWithClient(tempDir);

    const createResult = await c1.callTool({
      name: 'create_tree',
      arguments: { problem: 'Persistent problem' },
    });
    const { rootId, sessionId } = parseResult(createResult);

    const { childIds } = parseResult(await c1.callTool({
      name: 'decompose',
      arguments: { parentId: rootId, children: ['Cause A', 'Cause B', 'Cause C'] },
    }));

    await c1.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: childIds[0], type: 'supports', content: 'Evidence for A' },
    });
    await c1.callTool({
      name: 'score_hypothesis',
      arguments: { hypothesisId: childIds[0], score: 0.7 },
    });
    await c1.callTool({
      name: 'eliminate_hypothesis',
      arguments: { hypothesisId: childIds[1], reason: 'B is ruled out' },
    });

    await cleanup1();

    // Session 2: restart and verify state is restored
    const { sessions, hypotheses } = loadActiveSessions(tempDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].problem).toBe('Persistent problem');

    expect(hypotheses).toHaveLength(4); // root + 3 children
    const hypothesisA = hypotheses.find((h) => h.content === 'Cause A');
    expect(hypothesisA?.status).toBe('exploring');
    expect(hypothesisA?.score).toBe(0.7);
    expect(hypothesisA?.evidence).toHaveLength(1);
    expect(hypothesisA?.evidence[0].content).toBe('Evidence for A');

    const hypothesisB = hypotheses.find((h) => h.content === 'Cause B');
    expect(hypothesisB?.status).toBe('eliminated');
    expect(hypothesisB?.conclusion?.reason).toBe('B is ruled out');
  });

  it('JSONL contains one entry per mutation', async () => {
    const { client, cleanup } = await createServerWithClient(tempDir);

    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Count test' },
    }));
    await client.callTool({
      name: 'decompose',
      arguments: { parentId: rootId, children: ['X', 'Y'] },
    });
    await cleanup();

    const files = require('fs').readdirSync(tempDir).filter((f: string) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1);

    const content = readFileSync(join(tempDir, files[0]), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    // session-created + hypothesis-added(root) + hypothesis-added(X) + hypothesis-added(Y)
    expect(lines.length).toBeGreaterThanOrEqual(4);

    // Each line is valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('corrupt JSONL line is skipped without crashing', async () => {
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { sessionId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Corrupt test' },
    }));
    await cleanup();

    // Inject a corrupt line into the JSONL file
    const files = require('fs').readdirSync(tempDir).filter((f: string) => f.endsWith('.jsonl'));
    const filePath = join(tempDir, files[0]);
    const content = readFileSync(filePath, 'utf-8');
    const corrupted = content + 'THIS IS NOT JSON\n';
    require('fs').writeFileSync(filePath, corrupted);

    // Should load without throwing
    const { sessions, hypotheses } = loadActiveSessions(tempDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
  });

  it('empty directory results in no sessions', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'tot-empty-'));
    const { sessions, hypotheses } = loadActiveSessions(emptyDir);
    expect(sessions).toHaveLength(0);
    expect(hypotheses).toHaveLength(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('non-existent directory results in no sessions', () => {
    const { sessions, hypotheses } = loadActiveSessions('/tmp/definitely-not-a-real-path-xyz');
    expect(sessions).toHaveLength(0);
    expect(hypotheses).toHaveLength(0);
  });

  it('.gitignore is created in parent directory when parent is .tot', async () => {
    // ensureGitignore only writes when the parent dir ends with '.tot'
    const totDir = join(tempDir, '.tot');
    const dataDir = join(totDir, 'sessions');
    const { client, cleanup } = await createServerWithClient(dataDir);
    await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Gitignore test' },
    });
    await cleanup();

    const gitignorePath = join(totDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, 'utf-8').trim()).toBe('*');
  });

  it('.gitignore is NOT created when parent directory is not .tot', async () => {
    // Custom TOT_DATA_DIR paths should not get a blanket gitignore
    const customDir = join(tempDir, 'custom-data');
    const { client, cleanup } = await createServerWithClient(customDir);
    await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'No gitignore test' },
    });
    await cleanup();

    const gitignorePath = join(tempDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(false);
  });

  it('confirmed session persists as completed', async () => {
    const { client, cleanup } = await createServerWithClient(tempDir);

    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Confirm test' },
    }));
    await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: rootId, type: 'supports', content: 'proof' },
    });
    await client.callTool({
      name: 'confirm_hypothesis',
      arguments: { hypothesisId: rootId, reason: 'Root cause found' },
    });
    await cleanup();

    const { sessions } = loadActiveSessions(tempDir);
    expect(sessions[0].status).toBe('completed');
  });
});
