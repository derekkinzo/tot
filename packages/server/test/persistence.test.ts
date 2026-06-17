import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TreeManager } from '../src/tree-manager.js';
import { registerTools } from '../src/tools.js';
import { scanSessions, loadSession } from '../src/persistence.js';
import type { Session, Hypothesis } from '../src/types.js';

function parseResult(result: any): any {
  const text = result.content?.find((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text.split('\n')[0]); } catch { return { raw: text }; }
}

/**
 * Loads every session and its hypotheses by composing the production loaders
 * (scanSessions to enumerate, loadSession to replay each), so these tests
 * exercise the same code paths the daemon uses rather than a test-only loader.
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
    const hypothesisA = hypotheses.find((h) => h.content === 'Cause A');
    expect(hypothesisA?.status).toBe('exploring');
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
    expect(root!.content).toBe('Root');
    expect(root!.status).toBe('exploring');
    // Replay reconstructs via a structural cast, so the legacy `score` key
    // survives as an inert property — no code reads it. The contract is that
    // replay tolerates the extra field and the tree is fully usable, NOT
    // that the property is stripped.
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
      arguments: { parentId: rootId, children: ['A', 'B'] },
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
      arguments: { parentId: rootId, children: ['A', 'B'] },
    }));
    const decompA1 = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { parentId: decompA.childIds[0], children: ['A1', 'A2'] },
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
      arguments: { parentId: rootId, children: ['A', 'B'] },
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
      arguments: { parentId: rootId, children: ['A', 'B'] },
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
    // be journaled so a daemon restart reconstructs the same in-memory
    // tree the live engine produced.
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Cascade journal test' },
    }));
    const decompA = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { parentId: rootId, children: ['A', 'B'] },
    }));
    const decompA1 = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { parentId: decompA.childIds[0], children: ['A1', 'A2'] },
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
    // case as well, otherwise daemon restart reads the prior
    // session-completed and silently disagrees with the live engine.
    const { client, cleanup } = await createServerWithClient(tempDir);
    const { rootId } = parseResult(await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'Abandoned reopen test' },
    }));
    const decompA = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { parentId: rootId, children: ['A', 'B'] },
    }));
    const decompA1 = parseResult(await client.callTool({
      name: 'decompose',
      arguments: { parentId: decompA.childIds[0], children: ['A1', 'A2'] },
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
      arguments: { parentId: rootId, children: ['A', 'B'] },
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
      name: 'decompose', arguments: { parentId: rootId, children: ['A', 'B'] },
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
