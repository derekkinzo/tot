import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TreeManager } from '../src/tree-manager.js';
import { registerTools } from '../src/tools.js';
import { loadActiveSessions, scanSessions } from '../src/persistence.js';

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
      name: 'add_evidence',
      arguments: { hypothesisId: childIds[1], type: 'refutes', content: 'B is ruled out' },
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

  it('legacy eliminated records without refutingEvidenceIds replay with an empty array', () => {
    const sessionId = '00000000-0000-4000-8000-dddddddddddd';
    const rootId = '00000000-0000-4000-8000-eeeeeeeeeeee';
    const ts = '2024-02-01T00:00:00.000Z';
    const lines = [
      { timestamp: ts, type: 'session-created', payload: {
        id: sessionId, problem: 'Legacy elim', rootNodeId: rootId,
        status: 'open', createdAt: ts,
      } },
      { timestamp: ts, type: 'hypothesis-added', payload: {
        id: rootId, parentId: null, sessionId, depth: 0, content: 'Root',
        status: 'eliminated', score: null, evidence: [],
        // Pre-rework conclusion shape: no refutingEvidenceIds field.
        conclusion: { verdict: 'eliminated', reason: 'legacy', timestamp: ts },
        metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [],
      } },
    ];
    const filePath = join(tempDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const { hypotheses } = loadActiveSessions(tempDir);
    expect(hypotheses[0].conclusion?.refutingEvidenceIds).toEqual([]);
  });

  it('legacy JSONL with confirmed/active/completed literals replays under the new vocabulary', () => {
    // Hand-write a JSONL file using the pre-rename literals to simulate a
    // session written by an older binary. Read paths must translate without
    // mutating the bytes on disk.
    const sessionId = '00000000-0000-4000-8000-aaaaaaaaaaaa';
    const rootId = '00000000-0000-4000-8000-bbbbbbbbbbbb';
    const childId = '00000000-0000-4000-8000-cccccccccccc';
    const ts = '2024-01-01T00:00:00.000Z';
    const lines = [
      { timestamp: ts, type: 'session-created', payload: {
        id: sessionId, problem: 'Legacy', rootNodeId: rootId,
        status: 'active', createdAt: ts,
      } },
      { timestamp: ts, type: 'hypothesis-added', payload: {
        id: rootId, parentId: null, sessionId, depth: 0, content: 'Legacy',
        status: 'pending', score: null, evidence: [],
        metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [childId],
      } },
      { timestamp: ts, type: 'hypothesis-added', payload: {
        id: childId, parentId: rootId, sessionId, depth: 1, content: 'Old child',
        status: 'confirmed', score: null, evidence: [],
        conclusion: { verdict: 'confirmed', reason: 'legacy', timestamp: ts },
        metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [],
      } },
      { timestamp: ts, type: 'session-completed', payload: { sessionId } },
    ];
    const filePath = join(tempDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const { sessions, hypotheses } = loadActiveSessions(tempDir);
    expect(sessions[0].status).toBe('resolved');
    expect(hypotheses.find((h) => h.id === childId)?.status).toBe('corroborated');
    expect(hypotheses.find((h) => h.id === childId)?.conclusion?.verdict).toBe('corroborated');

    const index = scanSessions(tempDir);
    expect(index[0].status).toBe('resolved');

    // Bytes on disk are unchanged
    const reread = readFileSync(filePath, 'utf-8');
    expect(reread).toContain('"status":"active"');
    expect(reread).toContain('"status":"confirmed"');
    expect(reread).toContain('"verdict":"confirmed"');
  });

  it('corroborated session persists as resolved', async () => {
    const { client, cleanup } = await createServerWithClient(tempDir);

    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Corroborate test' },
    }));
    await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: rootId, type: 'supports', content: 'proof' },
    });
    await client.callTool({
      name: 'corroborate_hypothesis',
      arguments: { hypothesisId: rootId, reason: 'Root cause found' },
    });
    await cleanup();

    const { sessions } = loadActiveSessions(tempDir);
    expect(sessions[0].status).toBe('resolved');
  });
});
