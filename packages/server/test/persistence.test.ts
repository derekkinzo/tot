import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync, utimesSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TreeManager } from '../src/tree-manager.js';
import { registerTools } from '../src/tools.js';
import { scanSessions, makeSessionScanner, loadSession, pickActiveSession, Persistence, type SessionIndex } from '../src/persistence.js';
import { JOURNAL_SCHEMA_VERSION } from '../src/replay.js';
import type { Session, Hypothesis } from '../src/types.js';

function parseResult(result: any): any {
  const text = result.content?.find((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text.split('\n')[0]); } catch { return { raw: text }; }
}

/**
 * Loads every session and its hypotheses by composing the production loaders
 * (scanSessions to enumerate, loadSession to replay each), so these tests
 * exercise the same code paths the server uses rather than a test-only loader.
 */
function loadAllSessions(dataDir: string): { sessions: Session[]; hypotheses: Hypothesis[] } {
  const sessions: Session[] = [];
  const hypotheses: Hypothesis[] = [];
  for (const idx of scanSessions(dataDir)) {
    const loaded = loadSession(idx.filePath);
    if (loaded) {
      sessions.push(loaded.session);
      hypotheses.push(...loaded.hypotheses);
    }
  }
  return { sessions, hypotheses };
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

  it('stamps the schema version on every journal entry it writes', async () => {
    const p = new Persistence(tempDir, 'sess-ver');
    await p.append('session-created', { id: 'sess-ver' });
    const written = readFileSync(join(tempDir, 'sess-ver.jsonl'), 'utf-8').trim();
    const entry = JSON.parse(written);
    expect(entry.v).toBe(JOURNAL_SCHEMA_VERSION);
    expect(entry.type).toBe('session-created');
  });

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
      arguments: { axis: 'by cause', parentId: rootId, children: ['Cause A', 'Cause B', 'Cause C'] },
    }));

    await c1.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: childIds[0], type: 'supports', content: 'Evidence for A' },
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
    const { sessions, hypotheses } = loadAllSessions(tempDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].problem).toBe('Persistent problem');

    expect(hypotheses).toHaveLength(4); // root + 3 children
    const hypothesisA = hypotheses.find((h) => h.title === 'Cause A');
    expect(hypothesisA?.status).toBe('exploring');
    expect(hypothesisA?.evidence).toHaveLength(1);
    expect(hypothesisA?.evidence[0].content).toBe('Evidence for A');

    const hypothesisB = hypotheses.find((h) => h.title === 'Cause B');
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
      arguments: { axis: 'by cause', parentId: rootId, children: ['X', 'Y'] },
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
    const { sessions } = loadAllSessions(tempDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
  });

  it('empty directory results in no sessions', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'tot-empty-'));
    const { sessions, hypotheses } = loadAllSessions(emptyDir);
    expect(sessions).toHaveLength(0);
    expect(hypotheses).toHaveLength(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('non-existent directory results in no sessions', () => {
    const { sessions, hypotheses } = loadAllSessions('/tmp/definitely-not-a-real-path-xyz');
    expect(sessions).toHaveLength(0);
    expect(hypotheses).toHaveLength(0);
  });

  it('writes nothing but journals into the store, whatever the store is named', async () => {
    // The store lives outside any repo, so nothing there needs a marker file —
    // including when its directory happens to be named like one that would.
    const storeDir = join(tempDir, '.tot');
    const { client, cleanup } = await createServerWithClient(join(storeDir, 'sessions'));
    await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Store layout' },
    });
    await cleanup();

    expect(readdirSync(storeDir)).toEqual(['sessions']);
    expect(readdirSync(join(storeDir, 'sessions')).every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('scanSessions honors a later session-reopened over an earlier session-completed', () => {
    const sessionId = '00000000-0000-4000-8000-eeeeeeeeeeff';
    const rootId = '00000000-0000-4000-8000-ffffffffffaa';
    const ts = '2024-03-01T00:00:00.000Z';
    const lines = [
      { timestamp: ts, type: 'session-created', payload: {
        id: sessionId, problem: 'Reopened test', rootNodeId: rootId,
        status: 'open', createdAt: ts,
      } },
      { timestamp: ts, type: 'hypothesis-added', payload: {
        id: rootId, parentId: null, sessionId, depth: 0, content: 'Root',
        status: 'corroborated', score: null, evidence: [],
        conclusion: { verdict: 'corroborated', reason: 'survived', timestamp: ts, refutingEvidenceIds: [] },
        metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [],
      } },
      { timestamp: ts, type: 'session-completed', payload: { sessionId, terminalStatus: 'resolved' } },
      { timestamp: ts, type: 'session-reopened', payload: { sessionId } },
    ];
    const filePath = join(tempDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const index = scanSessions(tempDir);
    expect(index[0].status).toBe('open');
  });

  it('reports one terminal verdict for a journal, whichever reader asks', () => {
    // The session list and an opened session are two views of the same bytes. A
    // verdict derived in one and folded in the other means the same investigation
    // reads as answered in one place and abandoned in the other.
    const sessionId = '00000000-0000-4000-8000-aaaaaaaaaa21';
    const rootId = '00000000-0000-4000-8000-aaaaaaaaaa22';
    const ts = '2024-03-01T00:00:00.000Z';
    // A completion naming a state this build cannot read, over a surviving
    // corroborated hypothesis.
    const lines = [
      { timestamp: ts, type: 'session-created', payload: {
        id: sessionId, problem: 'Unreadable terminal state', rootNodeId: rootId, status: 'open', createdAt: ts,
      } },
      { timestamp: ts, type: 'hypothesis-added', payload: {
        id: rootId, parentId: null, sessionId, depth: 0, title: 'Root', status: 'corroborated',
        evidence: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [],
      } },
      { timestamp: ts, type: 'session-completed', payload: { sessionId, terminalStatus: 'closed' } },
    ];
    const filePath = join(tempDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const index = scanSessions(tempDir).find((e) => e.id === sessionId);
    const loaded = loadSession(filePath);
    expect(index, 'session not indexed').toBeTruthy();
    expect(loaded, 'session not loadable').toBeTruthy();
    expect(loaded!.session.status).toBe(index!.status);
    // And a corroborated hypothesis on a live lineage means an answer survived.
    expect(index!.status).toBe('resolved');
  });

  it('says so when a journal was written by a newer build, and still reads it', () => {
    // Silence would leave a reader believing they had the whole tree while
    // fields this build does not know about were dropped on the way in.
    const sessionId = '00000000-0000-4000-8000-aaaaaaaaaa11';
    const rootId = '00000000-0000-4000-8000-aaaaaaaaaa12';
    const ts = '2024-03-01T00:00:00.000Z';
    const lines = [
      { timestamp: ts, v: JOURNAL_SCHEMA_VERSION + 1, type: 'session-created', payload: {
        id: sessionId, problem: 'From the future', rootNodeId: rootId, status: 'open', createdAt: ts,
      } },
      { timestamp: ts, v: JOURNAL_SCHEMA_VERSION + 1, type: 'hypothesis-added', payload: {
        id: rootId, parentId: null, sessionId, depth: 0, title: 'Root',
        status: 'exploring', evidence: [],
        metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [],
      } },
    ];
    const filePath = join(tempDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const { sessions, hypotheses } = loadAllSessions(tempDir);
      // Read, not refused: a partial view of a session beats no view of it.
      expect(sessions).toHaveLength(1);
      expect(hypotheses.find((h) => h.id === rootId)?.title).toBe('Root');
    } finally {
      console.error = original;
    }
    expect(warnings.join('\n')).toMatch(/newer version/i);
    expect(warnings.join('\n')).toContain(filePath);
  });

  it('replays a legacy session whose events carry the removed score fields', () => {
    // score / scoreRationale were removed from the model. Old .tot sessions
    // on user machines still carry those keys in their hypothesis payloads;
    // replay must tolerate them (ignore as inert) and reconstruct the tree
    // cleanly with no leaked score value.
    const sessionId = '00000000-0000-4000-8000-aaaaaaaaaa01';
    const rootId = '00000000-0000-4000-8000-aaaaaaaaaa02';
    const ts = '2024-03-01T00:00:00.000Z';
    const lines = [
      { timestamp: ts, type: 'session-created', payload: {
        id: sessionId, problem: 'Legacy score session', rootNodeId: rootId,
        status: 'open', createdAt: ts,
      } },
      { timestamp: ts, type: 'hypothesis-added', payload: {
        id: rootId, parentId: null, sessionId, depth: 0, content: 'Root',
        status: 'exploring', score: 0.8, scoreRationale: 'legacy gut feel',
        evidence: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [],
      } },
    ];
    const filePath = join(tempDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const { sessions, hypotheses } = loadAllSessions(tempDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    const root = hypotheses.find((h) => h.id === rootId);
    expect(root).toBeDefined();
    // The one prose field a pre-title payload carries becomes the label. It
    // becomes a statement only where it says more than the label does, so a
    // node whose prose was already label-sized comes back without one.
    expect(root!.title).toBe('Root');
    expect(root!.statement).toBeUndefined();
    expect(root!.status).toBe('exploring');
    // Fields no longer in the contract are dropped rather than carried as inert
    // properties, so they cannot be re-journaled into every future snapshot.
    const asRecord = root! as unknown as Record<string, unknown>;
    expect('score' in asRecord).toBe(false);
    expect('scoreRationale' in asRecord).toBe(false);
    expect('content' in asRecord).toBe(false);
    expect(root!.evidence).toEqual([]);
    expect(root!.children).toEqual([]);
  });

  it('terminal session with mix of eliminated and out-of-scope replays as abandoned', async () => {
    // No corroborated leaf survived, so the closure has no answer to point at.
    // Eliminated and out-of-scope are both pruning verdicts; the
    // discriminator must classify the session as abandoned, not resolved.
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Mixed pruning test' },
    }));
    const { childIds } = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
    }));
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'gone' } });
    await client.callTool({ name: 'set_out_of_scope', arguments: { hypothesisId: childIds[1], reason: 'aside' } });
    await cleanup();

    const { sessions } = loadAllSessions(tempDir);
    expect(sessions[0].status).toBe('abandoned');
    const index = scanSessions(tempDir);
    expect(index[0].status).toBe('abandoned');
  });

  it('buried-corroborated under a pruned top-level branch round-trips as abandoned', async () => {
    // Engine closes the session as 'abandoned' (the only corroborated leaf
    // sits under an out-of-scope ancestor and so does not count as survival
    // on a non-pruned lineage). The wire event records terminalStatus.
    // Replay must defer to the wire AND the post-replay discriminator must
    // not flat-scan and silently flip the verdict back to 'resolved'.
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Buried corroboration test' },
    }));
    const decompA = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
    }));
    const decompA1 = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: decompA.childIds[0], children: ['A1', 'A2'] },
    }));
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA1.childIds[0], type: 'supports', content: 'survives' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: decompA1.childIds[0], reason: 'A1' } });
    await client.callTool({ name: 'set_out_of_scope', arguments: { hypothesisId: decompA.childIds[0], reason: 'aside' } });
    await client.callTool({ name: 'set_out_of_scope', arguments: { hypothesisId: decompA.childIds[1], reason: 'aside' } });
    await cleanup();

    const { sessions } = loadAllSessions(tempDir);
    expect(sessions[0].status).toBe('abandoned');
    const index = scanSessions(tempDir);
    expect(index[0].status).toBe('abandoned');
  });

  it('abandoned session round-trips: every-eliminated journal replays as abandoned, not resolved', async () => {
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Abandon test' },
    }));
    await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: rootId, type: 'refutes', content: 'no' },
    });
    await client.callTool({
      name: 'eliminate_hypothesis',
      arguments: { hypothesisId: rootId, reason: 'dead' },
    });
    await cleanup();

    const { sessions } = loadAllSessions(tempDir);
    expect(sessions[0].status).toBe('abandoned');
    const index = scanSessions(tempDir);
    expect(index[0].status).toBe('abandoned');
  });

  it('eliminate-driven resolution round-trips as resolved', async () => {
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Resolve via elimination' },
    }));
    const { childIds } = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
    }));
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'supports', content: 'yes' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'A' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[1], type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: childIds[1], reason: 'gone' } });
    await cleanup();

    const { sessions } = loadAllSessions(tempDir);
    expect(sessions[0].status).toBe('resolved');
  });

  it('set_out_of_scope-driven closure round-trips', async () => {
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Resolve via out-of-scope' },
    }));
    const { childIds } = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
    }));
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'supports', content: 'yes' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'A' } });
    await client.callTool({ name: 'set_out_of_scope', arguments: { hypothesisId: childIds[1], reason: 'aside' } });
    await cleanup();

    const { sessions } = loadAllSessions(tempDir);
    expect(sessions[0].status).toBe('resolved');
  });

  it('cascade demote round-trips: refute on a corroborated child journals demoted ancestors so replay agrees', async () => {
    // The cascade demotes corroborated ancestors when a corroborated
    // descendant is refuted. Both the descendant and every ancestor must
    // be journaled so a restart reconstructs the same in-memory
    // tree the live engine produced.
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Cascade journal test' },
    }));
    const decompA = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
    }));
    const decompA1 = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: decompA.childIds[0], children: ['A1', 'A2'] },
    }));
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA1.childIds[0], type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: decompA1.childIds[0], reason: 'gone' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA1.childIds[1], type: 'supports', content: 'yes' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: decompA1.childIds[1], reason: 'A2 wins' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA.childIds[0], type: 'supports', content: 'yes' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: decompA.childIds[0], reason: 'A wins via A2' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA.childIds[1], type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: decompA.childIds[1], reason: 'gone' } });
    // Session is now resolved with A and A2 corroborated. Refute A2 —
    // engine demotes A2 to exploring, cascades and demotes A to exploring,
    // and reopens the session.
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA1.childIds[1], type: 'refutes', content: 'counter-instance' } });
    await cleanup();

    const { sessions, hypotheses } = loadAllSessions(tempDir);
    expect(sessions[0].status).toBe('open');
    const a2 = hypotheses.find((h) => h.id === decompA1.childIds[1]);
    const a = hypotheses.find((h) => h.id === decompA.childIds[0]);
    // Both descendant and ancestor reload as 'exploring' — the cascade was
    // journaled, not just the leaf.
    expect(a2?.status).toBe('exploring');
    expect(a?.status).toBe('exploring');
    // Audit trail intact, distinguishing direct refute from cascade.
    expect(a2?.conclusion?.supersededBy).toBe('self');
    expect(a?.conclusion?.supersededBy).toBe('descendant');
  });

  it('abandoned-reopen round-trips: refute on a corroborated leaf in an abandoned session journals session-reopened', async () => {
    // Both terminal states reopen on refute against a corroborated leaf;
    // the persistence side must journal session-reopened for the abandoned
    // case as well, otherwise a restart reads the prior
    // session-completed and silently disagrees with the live engine.
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Abandoned reopen test' },
    }));
    const decompA = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
    }));
    const decompA1 = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: decompA.childIds[0], children: ['A1', 'A2'] },
    }));
    // A2 corroborated under A; A then eliminated (A2 buried under pruned A);
    // B eliminated. Session abandons (no live corroboration on the spine).
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA1.childIds[1], type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: decompA1.childIds[1], reason: 'gone' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA1.childIds[0], type: 'supports', content: 'survives' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: decompA1.childIds[0], reason: 'A2' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA.childIds[0], type: 'refutes', content: 'whole branch wrong' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: decompA.childIds[0], reason: 'pruned' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA.childIds[1], type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: decompA.childIds[1], reason: 'gone' } });
    // Session is now abandoned. Refute the buried-corroborated leaf —
    // engine reopens; persistence must record it so reload agrees.
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: decompA1.childIds[0], type: 'refutes', content: 'counter-instance' } });
    await cleanup();

    const { sessions } = loadAllSessions(tempDir);
    expect(sessions[0].status).toBe('open');
  });

  it('reopen-on-refute round-trips: session-reopened journal restores open status', async () => {
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Reopen test' },
    }));
    const { childIds } = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
    }));
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[1], type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: childIds[1], reason: 'gone' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'supports', content: 'yes' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'A' } });
    // Session is now resolved. Refute the corroborated leaf to reopen.
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'counter-instance' } });
    await cleanup();

    const { sessions } = loadAllSessions(tempDir);
    expect(sessions[0].status).toBe('open');
  });

  it('session-completed journal entry carries terminalStatus on disk', async () => {
    // The terminalStatus field on session-completed must be persisted, not
    // only emitted on SSE. Replay paths can then trust the explicit value
    // instead of reconstructing terminal status from hypothesis state.
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Wire test' },
    }));
    await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: rootId, type: 'supports', content: 'yes' },
    });
    await client.callTool({
      name: 'corroborate_hypothesis',
      arguments: { hypothesisId: rootId, reason: 'survives' },
    });
    await cleanup();

    const files = require('fs').readdirSync(tempDir).filter((f: string) => f.endsWith('.jsonl'));
    const content = readFileSync(join(tempDir, files[0]), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const completed = lines.find((l) => l.type === 'session-completed');
    expect(completed?.payload?.terminalStatus).toBe('resolved');
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

    const { sessions } = loadAllSessions(tempDir);
    expect(sessions[0].status).toBe('resolved');
  });

  // ─── Event-sourced journaling: on-disk format contract ───
  //
  // Journaling is driven by the engine event stream. These tests pin the
  // resulting on-disk format so a future "journal every event" change cannot
  // silently re-introduce the evidence double-apply path or reorder the log.

  function readJournalTypes(): string[] {
    const files = require('fs').readdirSync(tempDir).filter((f: string) => f.endsWith('.jsonl'));
    const content = readFileSync(join(tempDir, files[0]), 'utf-8');
    return content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).type);
  }

  it('add_evidence journals exactly one hypothesis-updated and zero evidence-added lines', async () => {
    // The engine emits evidence-added THEN hypothesis-updated; the journal must
    // record only the latter (which already carries the evidence), so replay
    // cannot apply the same evidence twice.
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree', arguments: { problem: 'Evidence omission' },
    }));
    await client.callTool({
      name: 'add_evidence', arguments: { hypothesisId: rootId, type: 'supports', content: 'datum' },
    });
    await cleanup();

    const types = readJournalTypes();
    expect(types.filter((t) => t === 'evidence-added')).toHaveLength(0);
    // session-created + hypothesis-added(root) + hypothesis-updated(root, post-evidence)
    expect(types).toEqual(['session-created', 'hypothesis-added', 'hypothesis-updated']);
  });

  it('journal line order on disk equals engine emit order for the reopen+cascade path', async () => {
    // The journal now inherits its ordering from the engine emit sequence
    // rather than hand-curated appends. Pin the exact disk order so a future
    // emit reorder in the engine fails here instead of silently reordering
    // the audit log.
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree', arguments: { problem: 'Order pin' },
    }));
    const { childIds } = parseResult(await client.callTool({
      name: 'decompose', arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
    }));
    // Resolve via A corroborated, B eliminated → session-completed.
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'supports', content: 'yes' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'A' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[1], type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: childIds[1], reason: 'gone' } });
    // Now refute the corroborated A: engine demotes A (hypothesis-updated) then
    // reopens the session (session-reopened) — in that order.
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'counter' } });
    await cleanup();

    const types = readJournalTypes();
    expect(types).toEqual([
      'session-created',
      'hypothesis-added',   // root
      'hypothesis-added',   // A
      'hypothesis-added',   // B
      'hypothesis-updated', // parent (root) after decompose
      'hypothesis-updated', // A after supports evidence
      'hypothesis-updated', // A corroborated
      'hypothesis-updated', // B after refutes evidence
      'hypothesis-updated', // B eliminated
      'session-completed',  // session resolves (A corroborated, B eliminated)
      'hypothesis-updated', // A demoted by the counter-evidence
      'session-reopened',   // session reopens — AFTER the demotion
    ]);
  });

});

describe('pickActiveSession', () => {
  const idx = (over: Partial<SessionIndex>): SessionIndex => ({
    id: 'id', problem: 'p', status: 'open', createdAt: '2024-01-01T00:00:00.000Z',
    filePath: '/x.jsonl', nodeCount: 1, unreadableLines: 0, ...over,
  });

  it('returns undefined for an empty index', () => {
    expect(pickActiveSession([])).toBeUndefined();
  });

  it('prefers the most recently created OPEN session over a newer terminal one', () => {
    const oldOpen = idx({ id: 'old-open', status: 'open', createdAt: '2024-01-01T00:00:00.000Z' });
    const newResolved = idx({ id: 'new-resolved', status: 'resolved', createdAt: '2024-06-01T00:00:00.000Z' });
    expect(pickActiveSession([newResolved, oldOpen])?.id).toBe('old-open');
  });

  it('among multiple open sessions, picks the most recently created', () => {
    const a = idx({ id: 'a', status: 'open', createdAt: '2024-01-01T00:00:00.000Z' });
    const b = idx({ id: 'b', status: 'open', createdAt: '2024-03-01T00:00:00.000Z' });
    expect(pickActiveSession([a, b])?.id).toBe('b');
  });

  it('falls back to the most recent overall when no session is open', () => {
    const older = idx({ id: 'older', status: 'resolved', createdAt: '2024-01-01T00:00:00.000Z' });
    const newer = idx({ id: 'newer', status: 'abandoned', createdAt: '2024-09-01T00:00:00.000Z' });
    expect(pickActiveSession([older, newer])?.id).toBe('newer');
  });
});

describe('a journal left ending mid-record', () => {
  // An append can write some of its bytes and then fail, leaving a record with
  // no terminator. Appending straight onto those bytes splices two records into
  // one unreadable line and loses BOTH — including the later one, whose own
  // append succeeded and was therefore reported as written.

  let dataDir: string;
  const sessionId = 'sess-torn';
  const journal = () => join(dataDir, `${sessionId}.jsonl`);
  const line = (type: string, payload: unknown) =>
    JSON.stringify({ v: JOURNAL_SCHEMA_VERSION, timestamp: '2024-01-01T00:00:00.000Z', type, payload }) + '\n';

  const header = line('session-created', {
    id: sessionId, problem: 'Recover from a partial write', rootNodeId: 'root',
    status: 'open', createdAt: '2024-01-01T00:00:00.000Z',
  });
  const node = (id: string, over: Record<string, unknown> = {}) => line('hypothesis-added', {
    id, parentId: 'root', sessionId, depth: 1, title: id, status: 'pending',
    evidence: [], children: [], metadata: { createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', source: 'agent' },
    ...over,
  });
  const root = node('root', { parentId: null, depth: 0 });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tot-torn-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not swallow a record appended after ANOTHER writer left it torn', async () => {
    // The journal is shared. A peer holding the same session can be killed
    // part-way through a write at any moment, including long after this writer
    // was constructed — so what this writer last did says nothing about whether
    // the file ends mid-record now. Reading it from the file each time is what
    // makes the guard hold for a partial record it did not write.
    writeFileSync(journal(), header + root);
    const p = new Persistence(dataDir, sessionId);
    await p.append('hypothesis-added', {
      id: 'mine', parentId: 'root', sessionId, depth: 1, title: 'mine', status: 'pending',
      evidence: [], children: [], metadata: { createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', source: 'agent' },
    });

    // A peer's append dies half-written, after this writer's own last success.
    writeFileSync(journal(), readFileSync(journal(), 'utf-8') + node('torn').slice(0, 40), 'utf-8');

    await p.append('hypothesis-added', {
      id: 'after', parentId: 'root', sessionId, depth: 1, title: 'after', status: 'pending',
      evidence: [], children: [], metadata: { createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', source: 'agent' },
    });

    // Both of this writer's records survive; only the peer's torn one is lost.
    const loaded = loadSession(journal());
    expect(loaded!.hypotheses.map((h) => h.id)).toEqual(['root', 'mine', 'after']);
    expect(loaded!.unreadableLines).toBe(1);
  });

  it('does not swallow the next record appended to it', async () => {
    // Truncate the last record mid-way, exactly as a failed append leaves it.
    writeFileSync(journal(), header + root + node('kept').slice(0, 40));
    await new Persistence(dataDir, sessionId).append('hypothesis-added', {
      id: 'after', parentId: 'root', sessionId, depth: 1, title: 'after', status: 'pending',
      evidence: [], children: [], metadata: { createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', source: 'agent' },
    });

    const loaded = loadSession(journal());
    expect(loaded!.hypotheses.map((h) => h.id)).toEqual(['root', 'after']);
  });

  it('reports the records it could not read, so a smaller tree is not mistaken for the whole one', () => {
    writeFileSync(journal(), header + root + 'this line is not json\n' + node('kept'));
    const warnings: string[] = [];
    const original = console.error;
    console.error = (msg?: unknown) => { warnings.push(String(msg)); };
    try {
      loadSession(journal());
    } finally {
      console.error = original;
    }
    expect(warnings.join('\n')).toMatch(/1 of 4 records/);
  });

  it('says nothing when every record was read', () => {
    writeFileSync(journal(), header + root + node('kept'));
    const warnings: string[] = [];
    const original = console.error;
    console.error = (msg?: unknown) => { warnings.push(String(msg)); };
    try {
      loadSession(journal());
    } finally {
      console.error = original;
    }
    expect(warnings).toEqual([]);
  });

  it('keeps a session whose header line is unreadable, rather than losing every node with it', () => {
    writeFileSync(journal(), '{"v":2,"type":"session-created","paylo' + '\n' + root + node('kept'));
    const loaded = loadSession(journal());
    expect(loaded).not.toBeNull();
    expect(loaded!.session.id).toBe(sessionId);
    expect(loaded!.hypotheses.map((h) => h.id)).toEqual(['root', 'kept']);
  });

  it('lists that session in the index too, so both surfaces see the same file', () => {
    writeFileSync(journal(), '{"v":2,"type":"session-created","paylo' + '\n' + root + node('kept'));
    expect(scanSessions(dataDir).map((s) => ({ id: s.id, nodeCount: s.nodeCount })))
      .toEqual([{ id: sessionId, nodeCount: 2 }]);
  });

  it('carries the count of unread records, so a surface can say the tree may be short', () => {
    // The warning goes to a log nobody reading the tree will see. Every surface
    // that renders the tree needs the count with it, or the smaller tree it draws
    // is indistinguishable from the whole one.
    writeFileSync(journal(), header + root + 'this line is not json\n' + node('kept'));
    expect(scanSessions(dataDir)[0].unreadableLines).toBe(1);
    expect(loadSession(journal())!.unreadableLines).toBe(1);
  });

  it('reports none when every record was read, so the caveat is only shown when earned', () => {
    writeFileSync(journal(), header + root + node('kept'));
    expect(scanSessions(dataDir)[0].unreadableLines).toBe(0);
    expect(loadSession(journal())!.unreadableLines).toBe(0);
  });

  it('counts every unread record, not merely that there was one', () => {
    writeFileSync(journal(), header + root + 'garbage one\n' + node('kept') + 'garbage two\n');
    expect(loadSession(journal())!.unreadableLines).toBe(2);
  });
});

describe('an acknowledged append', () => {
  let dataDir: string;
  const sessionId = 'sess-durable';

  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'tot-durable-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  /**
   * The FileHandle prototype, which every `open()` hands back, so what a writer
   * does with its handle is observable however it obtained one.
   */
  async function handleProto(): Promise<{ datasync: () => Promise<void>; appendFile: (d: string) => Promise<void> }> {
    const probe = await open(join(dataDir, 'probe'), 'a');
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    return proto;
  }

  it('has reached the device, not merely the kernel', async () => {
    // The caller is told its mutation was saved. Bytes the kernel is holding
    // survive this process dying but not the machine doing so, and the
    // acknowledgement does not distinguish the two — so the same words would
    // stand for a record that is on disk and one that is about to not exist.
    const proto = await handleProto();
    const datasync = vi.spyOn(proto, 'datasync');
    try {
      await new Persistence(dataDir, sessionId).append('session-created', { id: sessionId });
      expect(datasync).toHaveBeenCalled();
    } finally {
      datasync.mockRestore();
    }
  });

  it('syncs the record it just wrote, not the file as it stood before', async () => {
    // A sync that runs first flushes a file that does not hold the record yet, so
    // the record is left in exactly the state the sync exists to rule out while
    // every observation of "datasync was called" still holds.
    const proto = await handleProto();
    const datasync = vi.spyOn(proto, 'datasync');
    const appendFile = vi.spyOn(proto, 'appendFile');
    try {
      await new Persistence(dataDir, sessionId).append('session-created', { id: sessionId });
      expect(appendFile).toHaveBeenCalled();
      expect(datasync.mock.invocationCallOrder[0])
        .toBeGreaterThan(appendFile.mock.invocationCallOrder[0]);
    } finally {
      datasync.mockRestore();
      appendFile.mockRestore();
    }
  });

  it('does not resolve until the sync it started has finished', async () => {
    // Starting the sync without waiting for it leaves the acknowledgement exactly
    // as premature as it was without any sync at all: the caller is told the
    // record is on the device while the flush is still in flight.
    const proto = await handleProto();
    let releaseSync: (() => void) | undefined;
    const datasync = vi.spyOn(proto, 'datasync').mockImplementation(
      () => new Promise<void>((resolve) => { releaseSync = resolve; }),
    );
    try {
      let resolved = false;
      const appended = new Persistence(dataDir, sessionId)
        .append('session-created', { id: sessionId })
        .then(() => { resolved = true; });

      // Opening and writing are real I/O, so wait for the append to arrive at
      // the sync before judging what it does there.
      for (let i = 0; i < 200 && datasync.mock.calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(datasync, 'the append never reached the sync').toHaveBeenCalled();
      // Now nothing but the sync completing may let it through.
      await new Promise((r) => setTimeout(r, 25));
      expect(resolved, 'the append resolved while the sync was still in flight').toBe(false);

      releaseSync!();
      await appended;
      expect(resolved).toBe(true);
    } finally {
      datasync.mockRestore();
    }
  });

  it.skipIf(!existsSync('/proc/self/fd'))(
    'gives back the handle it opened, so a long session cannot run out of descriptors',
    async () => {
      const count = () => readdirSync('/proc/self/fd').length;
      const p = new Persistence(dataDir, sessionId);
      await p.append('session-created', { id: sessionId });
      const before = count();
      for (let i = 0; i < 40; i++) await p.append('hypothesis-added', { id: `h${i}` });
      // One descriptor per append would be 40; a handful of slack absorbs whatever
      // else the runtime opened while these ran.
      expect(count() - before).toBeLessThan(10);
    },
  );

  it('is still readable as one record per line after many appends', async () => {
    const p = new Persistence(dataDir, sessionId);
    for (let i = 0; i < 25; i++) await p.append('hypothesis-added', { id: `h${i}` });
    const lines = readFileSync(join(dataDir, `${sessionId}.jsonl`), 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(25);
    expect(lines.map((l) => (JSON.parse(l) as { payload: { id: string } }).payload.id))
      .toEqual(Array.from({ length: 25 }, (_, i) => `h${i}`));
  });
});

describe('a session file that cannot be read at all', () => {
  // There is no session in it to list, so the only thing that can be said is
  // that it was there and was left out. Said on stderr, because a project
  // reporting one fewer session than it holds, in silence, reads as a project
  // that never had it.
  let dataDir: string;
  const ts = '2024-01-01T00:00:00.000Z';
  const line = (type: string, payload: unknown) =>
    JSON.stringify({ v: JOURNAL_SCHEMA_VERSION, timestamp: ts, type, payload }) + '\n';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tot-unreadable-'));
    // A readable session, so the scan has something to keep.
    writeFileSync(join(dataDir, 'good.jsonl'), [
      line('session-created', { id: 'good', problem: 'a readable session', rootNodeId: 'root', status: 'open', createdAt: ts }),
      line('hypothesis-added', {
        id: 'root', parentId: null, sessionId: 'good', depth: 0, title: 'root', status: 'pending',
        evidence: [], children: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' },
      }),
    ].join(''));
    // A name the scan accepts that cannot be read as a file at all.
    mkdirSync(join(dataDir, 'unreadable.jsonl'));
  });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  /** Runs `fn`, returning everything it wrote to stderr. */
  function captureStderr(fn: () => void): string {
    const seen: string[] = [];
    const original = console.error;
    console.error = (msg?: unknown) => { seen.push(String(msg)); };
    try { fn(); } finally { console.error = original; }
    return seen.join('\n');
  }

  it('names the file it could not read', () => {
    const warnings = captureStderr(() => scanSessions(dataDir));
    expect(warnings).toContain('unreadable.jsonl');
  });

  it('still lists every session it could read', () => {
    let index: SessionIndex[] = [];
    captureStderr(() => { index = scanSessions(dataDir); });
    expect(index.map((s) => s.id)).toEqual(['good']);
  });

  it('says nothing when every file was readable, so the warning is only shown when earned', () => {
    rmSync(join(dataDir, 'unreadable.jsonl'), { recursive: true });
    expect(captureStderr(() => scanSessions(dataDir))).toBe('');
  });
});

describe('a journal that becomes writable again', () => {
  // The notice a failed append raises says the tree is not being written to
  // disk. Once one is, a notice that cannot be withdrawn is saying something
  // untrue — and teaches the reader to disregard the next one.
  let dataDir: string;
  const sessionId = 'sess-recover';

  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'tot-recover-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('reports that an append landed, not only that one failed', async () => {
    const events: string[] = [];
    const p = new Persistence(
      dataDir, sessionId,
      () => events.push('failed'),
      () => events.push('landed'),
    );
    await p.append('session-created', { id: sessionId });
    expect(events).toEqual(['landed']);
  });

  it('reports the landing after a failure, in that order', async () => {
    const events: string[] = [];
    const journal = join(dataDir, `${sessionId}.jsonl`);
    writeFileSync(journal, '');
    chmodSync(journal, 0o444);
    const p = new Persistence(
      dataDir, sessionId,
      () => events.push('failed'),
      () => events.push('landed'),
    );
    await expect(p.append('session-created', { id: sessionId })).rejects.toThrow();
    chmodSync(journal, 0o644);
    await p.append('hypothesis-added', { id: 'root' });
    expect(events).toEqual(['failed', 'landed']);
  });
});

describe('a repeated scan of one store', () => {
  // Every enumeration re-reads the store, because a peer can add to it at any
  // time. A fold costs a read and a parse of the whole journal, and journals grow
  // without bound while their content stops changing — so an enumeration on a
  // timer would spend that on producing the answer it already had.
  let dataDir: string;
  const ts = '2024-01-01T00:00:00.000Z';
  const line = (type: string, payload: unknown) =>
    JSON.stringify({ v: JOURNAL_SCHEMA_VERSION, timestamp: ts, type, payload }) + '\n';

  const session = (id: string, problem: string) =>
    line('session-created', { id, problem, rootNodeId: `${id}-root`, status: 'open', createdAt: ts })
    + line('hypothesis-added', {
      id: `${id}-root`, parentId: null, sessionId: id, depth: 0, title: problem, status: 'exploring',
      evidence: [], children: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' },
    });
  const node = (sessionId: string, id: string) => line('hypothesis-added', {
    id, parentId: `${sessionId}-root`, sessionId, depth: 1, title: id, status: 'pending',
    evidence: [], children: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' },
  });
  const journal = (id: string) => join(dataDir, `${id}.jsonl`);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tot-rescan-'));
    writeFrozen(journal('a'), session('a', 'the first investigation'));
  });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  /** A modification time this suite pins, so two writes are indistinguishable to
   *  anything reading size and mtime. */
  const FROZEN = new Date(1700000000000);

  /**
   * Writes `content` and stamps the frozen time, so the gate's two signals are
   * whatever the caller arranges rather than whatever the clock said.
   */
  function writeFrozen(path: string, content: string): void {
    writeFileSync(path, content);
    utimesSync(path, FROZEN, FROZEN);
  }

  /**
   * Replaces a journal's bytes with different content of the same length, under
   * the same modification time — so both of the gate's signals stand while the
   * content does not. Whether the new content is reported says whether the file
   * was folded again.
   *
   * A real journal cannot reach this state: it is only ever appended to, so any
   * record that lands moves its size. That is the premise the gate rests on, and
   * this is how the gate itself is observed.
   */
  function rewriteInPlace(path: string, content: string): void {
    expect(Buffer.byteLength(content), 'the replacement must be the same length')
      .toBe(statSync(path).size);
    writeFrozen(path, content);
  }

  it('reports the same sessions on a second scan', () => {
    const rescan = makeSessionScanner(dataDir);
    const first = rescan();
    const second = rescan();
    expect(second).toEqual(first);
    expect(second.map((s) => s.id)).toEqual(['a']);
  });

  it('does not read a journal again while its size and time stand', () => {
    const rescan = makeSessionScanner(dataDir);
    expect(rescan()[0].problem).toBe('the first investigation');
    rewriteInPlace(journal('a'), session('a', 'THE FIRST INVESTIGATION'));
    expect(rescan()[0].problem, 'the journal was folded again').toBe('the first investigation');
  });

  it('re-reads a journal that grew, and reports what was appended', () => {
    const rescan = makeSessionScanner(dataDir);
    expect(rescan()[0].nodeCount).toBe(1);
    writeFileSync(journal('a'), readFileSync(journal('a'), 'utf-8') + node('a', 'a-child'));
    const again = rescan();
    expect(again[0].nodeCount).toBe(2);
  });

  it('re-reads a journal whose time moved, even at the same size', () => {
    // Size alone is not the signal: a writer can replace a record with one of the
    // same length, and only the modification time distinguishes that from the file
    // already folded.
    const rescan = makeSessionScanner(dataDir);
    expect(rescan()[0].problem).toBe('the first investigation');
    writeFileSync(journal('a'), session('a', 'THE FIRST INVESTIGATION'));
    utimesSync(journal('a'), new Date(FROZEN.getTime() + 60_000), new Date(FROZEN.getTime() + 60_000));
    expect(rescan()[0].problem).toBe('THE FIRST INVESTIGATION');
  });

  it('forgets a journal that went away, so its replacement is read afresh', () => {
    // A long-lived server enumerates many times; what it remembers about files
    // that are gone would otherwise accumulate, and a new file landing on a
    // recycled name would be answered for by the old one.
    const rescan = makeSessionScanner(dataDir);
    expect(rescan()[0].problem).toBe('the first investigation');
    rmSync(journal('a'));
    expect(rescan()).toEqual([]);
    writeFrozen(journal('a'), session('a', 'THE FIRST INVESTIGATION'));
    expect(rescan()[0].problem, 'answered from what was remembered about the old file')
      .toBe('THE FIRST INVESTIGATION');
  });

  it('picks up a session another process added', () => {
    const rescan = makeSessionScanner(dataDir);
    expect(rescan().map((s) => s.id)).toEqual(['a']);
    writeFileSync(journal('b'), session('b', 'a second investigation'));
    expect(rescan().map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('drops a session whose journal is gone', () => {
    const rescan = makeSessionScanner(dataDir);
    rescan();
    rmSync(journal('a'));
    expect(rescan()).toEqual([]);
  });

  it('agrees with a scan that keeps nothing', () => {
    // The gate is an optimisation, so its answer has to be the one the plain read
    // gives — including the count of records it could not read.
    writeFileSync(journal('b'), session('b', 'a second investigation') + 'this line is not json\n');
    const rescan = makeSessionScanner(dataDir);
    const byGate = rescan();
    rescan(); // a second pass, now answering from the cache
    expect(rescan()).toEqual(scanSessions(dataDir));
    expect(byGate).toEqual(scanSessions(dataDir));
    expect(byGate.find((s) => s.id === 'b')!.unreadableLines).toBe(1);
  });

  it('remembers that a file describes no session, rather than folding it every time', () => {
    const notASession = join(dataDir, 'not-a-session.jsonl');
    const filler = session('b', 'a second investigation');
    writeFrozen(notASession, 'x'.repeat(filler.length - 1) + '\n');
    const rescan = makeSessionScanner(dataDir);
    expect(rescan().map((s) => s.id)).toEqual(['a']);
    rewriteInPlace(notASession, filler);
    expect(rescan().map((s) => s.id), 'the file was folded again').toEqual(['a']);
  });

  it('tries again after a read failure rather than caching it', () => {
    // A file unreadable now may be readable next time; caching the failure would
    // keep reporting a session as absent after the cause is gone.
    const unreadable = join(dataDir, 'locked.jsonl');
    writeFileSync(unreadable, session('locked', 'a session behind a permission'));
    chmodSync(unreadable, 0o000);
    const rescan = makeSessionScanner(dataDir);
    const warned: string[] = [];
    const original = console.error;
    console.error = (m?: unknown) => { warned.push(String(m)); };
    try {
      expect(rescan().map((s) => s.id)).toEqual(['a']);
      chmodSync(unreadable, 0o644);
      expect(rescan().map((s) => s.id).sort()).toEqual(['a', 'locked']);
    } finally {
      console.error = original;
      chmodSync(unreadable, 0o644);
    }
    expect(warned.join('\n')).toContain('locked.jsonl');
  });
});
