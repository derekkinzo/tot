/**
 * Comprehensive API test campaign — exercises the tool-handler wire boundary
 * (Zod parse + handler dispatch + response formatting) against isolated
 * TreeManagers. Every case captures the exact input and asserts the exact
 * output text/envelope and resulting state, per the API test matrix.
 *
 * This complements integration.test.ts (which checks isError booleans) by
 * asserting the Validation-error-vs-Error layer distinction, exact advisory
 * text, and state-machine transitions at the tool layer.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TreeManager } from '../src/tree-manager.js';
import { getToolHandlers } from '../src/tools.js';

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function makeHarness() {
  const tm = new TreeManager({ stagnationThreshold: 4 });
  const dataDir = mkdtempSync(join(tmpdir(), 'tot-api-'));
  const handlers = getToolHandlers(tm, () => dataDir);
  const call = async (tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const h = handlers.get(tool);
    if (!h) throw new Error(`no handler: ${tool}`);
    return (await h(args)) as ToolResult;
  };
  const text = (r: ToolResult) => r.content[0]?.text ?? '';
  const json = (r: ToolResult) => {
    try { return JSON.parse(text(r).split('\n')[0]); } catch { return null; }
  };
  // hypothesis lookup against the active session's tree (hypotheses is a Map)
  const hyp = (id: string) => {
    const sess = tm.getStatus().session;
    const state = sess ? tm.getTree(sess.id) : tm.getTree();
    return state?.hypotheses.get(id) ?? null;
  };
  // session status regardless of open/terminal — find by scanning all trees
  const sessionStatusFor = (sessionId: string) => tm.getTree(sessionId)?.session.status ?? null;
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true });
  return { tm, call, text, json, hyp, sessionStatusFor, cleanup };
}

// ─────────────────────────── create_tree ───────────────────────────
describe('API: create_tree', () => {
  it('CT-01 happy: envelope + formatCreateTree text + open session', async () => {
    const { call, text, json, tm, hyp, cleanup } = makeHarness();
    const r = await call('create_tree', { problem: 'Why is the API slow?' });
    expect(r.isError).toBeFalsy();
    const env = json(r);
    expect(env.sessionId).toBeTruthy();
    expect(env.rootId).toBeTruthy();
    const t = text(r);
    expect(t).toContain('✓ Tree created: "Why is the API slow?"');
    expect(t).toContain('── Domain Investigation ──');
    expect(t).toContain('For EACH hypothesis, define what observation would REFUTE it.');
    expect(t).toMatch(/0 hypotheses \| Session: [0-9a-f]{8}/);
    expect(tm.getTree(env.sessionId)!.session.status).toBe('open');
    expect(hyp(env.rootId)!.status).toBe('pending');
    cleanup();
  });

  it('CT-02 long problem: display truncates, stored content full', async () => {
    const { call, text, json, hyp, cleanup } = makeHarness();
    const problem = 'P'.repeat(120);
    const r = await call('create_tree', { problem });
    const t = text(r);
    // truncate(s,70): first 69 chars + …
    expect(t).toContain('✓ Tree created: "' + 'P'.repeat(69) + '…"');
    expect(hyp(json(r).rootId)!.content.length).toBe(120);
    cleanup();
  });

  it('CT-04 unicode preserved', async () => {
    const { call, json, hyp, cleanup } = makeHarness();
    const problem = 'héllo 日本語 🎉 <>&"\'';
    const r = await call('create_tree', { problem });
    expect(hyp(json(r).rootId)!.content).toBe(problem);
    cleanup();
  });

  it('CT-06 empty string → Validation error (Zod min)', async () => {
    const { call, text, cleanup } = makeHarness();
    const r = await call('create_tree', { problem: '' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Validation error:/);
    cleanup();
  });

  it('CT-07 whitespace-only → engine Error (trim guard, not Zod)', async () => {
    const { call, text, cleanup } = makeHarness();
    const r = await call('create_tree', { problem: '   ' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Error:/);
    expect(text(r)).toContain('empty');
    cleanup();
  });

  it('CT-08 over-max → Validation error', async () => {
    const { call, text, cleanup } = makeHarness();
    const r = await call('create_tree', { problem: 'x'.repeat(10001) });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Validation error:/);
    cleanup();
  });

  it('CT-09 missing problem → Validation error', async () => {
    const { call, text, cleanup } = makeHarness();
    const r = await call('create_tree', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Validation error:/);
    cleanup();
  });
});

// helper to build a decomposed tree
async function rootWithChildren(call: any, json: any, children: string[]) {
  const c = await call('create_tree', { problem: 'P' });
  const rootId = json(c).rootId;
  const sessionId = json(c).sessionId;
  const d = await call('decompose', { parentId: rootId, children });
  return { rootId, sessionId, childIds: json(d).childIds as string[] };
}

// ─────────────────────────── decompose ───────────────────────────
describe('API: decompose', () => {
  it('DC-01 happy: root pending→exploring, 2 children, review block', async () => {
    const { call, json, hyp, cleanup } = makeHarness();
    const { rootId, childIds } = await rootWithChildren(call, json, ['A', 'B']);
    expect(childIds).toHaveLength(2);
    expect(hyp(rootId)!.status).toBe('exploring');
    expect(childIds.every((id) => hyp(id)!.status === 'pending')).toBe(true);
    cleanup();
  });

  it('DC-05 >7 children advisory', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const r = await call('decompose', {
      parentId: json(c).rootId,
      children: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    expect(text(r)).toMatch(/8 children/);
    cleanup();
  });

  it('DC-08 substring overlap advisory', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const r = await call('decompose', { parentId: json(c).rootId, children: ['Network error', 'Network'] });
    expect(text(r)).toMatch(/[Oo]verlap/);
    cleanup();
  });

  it('DC-13 decompose eliminated parent → Error', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    await call('add_evidence', { hypothesisId: childIds[1], type: 'refutes', content: 'x' });
    await call('eliminate_hypothesis', { hypothesisId: childIds[1], reason: 'r' });
    const r = await call('decompose', { parentId: childIds[1], children: ['x', 'y'] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Cannot decompose .* eliminated/);
    cleanup();
  });

  it('DC-18 only one child → Validation error (Zod min 2), not engine', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const r = await call('decompose', { parentId: json(c).rootId, children: ['only'] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Validation error:/);
    cleanup();
  });

  it('DC-19 21 children → Validation error (Zod max 20)', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const r = await call('decompose', {
      parentId: json(c).rootId,
      children: Array.from({ length: 21 }, (_, i) => `c${i}`),
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Validation error:/);
    cleanup();
  });

  it('DC-21 nonexistent parent → Error not found', async () => {
    const { call, text, cleanup } = makeHarness();
    await call('create_tree', { problem: 'P' });
    const r = await call('decompose', { parentId: 'fake', children: ['a', 'b'] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not found');
    cleanup();
  });
});

// ─────────────────────────── add_hypothesis ───────────────────────────
describe('API: add_hypothesis', () => {
  it('AH-02 add to pending root does NOT flip to exploring (asymmetry vs decompose)', async () => {
    const { call, json, hyp, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    await call('add_hypothesis', { parentId: rootId, content: 'C' });
    expect(hyp(rootId)!.status).toBe('pending');
    cleanup();
  });

  it('AH-05 add to corroborated parent → Error', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 'x' });
    await call('corroborate_hypothesis', { hypothesisId: rootId, reason: 'r' });
    const r = await call('add_hypothesis', { parentId: rootId, content: 'C' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Cannot add hypothesis to a corroborated/);
    cleanup();
  });

  it('AH-09 nonexistent parent → Error', async () => {
    const { call, text, cleanup } = makeHarness();
    await call('create_tree', { problem: 'P' });
    const r = await call('add_hypothesis', { parentId: 'fake', content: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not found');
    cleanup();
  });
});

// ─────────────────────────── add_evidence ───────────────────────────
describe('API: add_evidence', () => {
  it('AE-01 first evidence: root pending→exploring, envelope count', async () => {
    const { call, json, hyp, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    const r = await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 'log', source: 'app.log' });
    expect(json(r).evidenceCount).toBe(1);
    expect(hyp(rootId)!.status).toBe('exploring');
    cleanup();
  });

  it('AE-12 refute corroborated leaf → reopen session (resolved→open)', async () => {
    const { call, json, tm, text, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 's' });
    await call('corroborate_hypothesis', { hypothesisId: rootId, reason: 'r' });
    expect(tm.getStatus().session).toBeNull(); // resolved → no open session
    const r = await call('add_evidence', { hypothesisId: rootId, type: 'refutes', content: 'counter' });
    expect(r.isError).toBeFalsy();
    // session reopened
    const status = tm.getStatus();
    expect(status.session).not.toBeNull();
    expect(status.session!.status).toBe('open');
    cleanup();
  });

  it('AE-13 supports on corroborated leaf → Error (only refutes admitted)', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 's' });
    await call('corroborate_hypothesis', { hypothesisId: rootId, reason: 'r' });
    const r = await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 'more' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/[Oo]nly refuting evidence/);
    cleanup();
  });

  it('AE-17 evidence to eliminated → Error', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    await call('add_evidence', { hypothesisId: childIds[1], type: 'refutes', content: 'x' });
    await call('eliminate_hypothesis', { hypothesisId: childIds[1], reason: 'r' });
    const r = await call('add_evidence', { hypothesisId: childIds[1], type: 'neutral', content: 'y' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Cannot add evidence to a eliminated/);
    cleanup();
  });

  it('AE-19 nonexistent target → Error contains id', async () => {
    const { call, text, cleanup } = makeHarness();
    await call('create_tree', { problem: 'P' });
    const r = await call('add_evidence', { hypothesisId: 'fake-id-123', type: 'supports', content: 'd' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('fake-id-123');
    cleanup();
  });

  it('AE-20 bad enum type → Validation error', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const r = await call('add_evidence', { hypothesisId: json(c).rootId, type: 'bogus', content: 'd' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Validation error:/);
    cleanup();
  });

  it('AE-24 duplicate evidence allowed (no dedup)', async () => {
    const { call, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 'same' });
    const r = await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 'same' });
    expect(json(r).evidenceCount).toBe(2);
    cleanup();
  });
});

// ─────────────────────────── eliminate_hypothesis ───────────────────────────
describe('API: eliminate_hypothesis', () => {
  it('EL-04 eliminate all top-level siblings → session abandoned', async () => {
    const { call, json, sessionStatusFor, cleanup } = makeHarness();
    const { sessionId, childIds } = await rootWithChildren(call, json, ['A', 'B']);
    for (const id of childIds) {
      await call('add_evidence', { hypothesisId: id, type: 'refutes', content: 'x' });
      await call('eliminate_hypothesis', { hypothesisId: id, reason: 'r' });
    }
    // every top-level branch terminal, no corroboration anywhere → abandoned
    expect(sessionStatusFor(sessionId)).toBe('abandoned');
    cleanup();
  });

  it('EL-08 eliminate without refuting evidence → Error (falsification guard)', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    const r = await call('eliminate_hypothesis', { hypothesisId: childIds[0], reason: 'r' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/refuting evidence/);
    cleanup();
  });

  it('EL-09 eliminate already eliminated → Error idempotency', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    await call('add_evidence', { hypothesisId: childIds[0], type: 'refutes', content: 'x' });
    await call('eliminate_hypothesis', { hypothesisId: childIds[0], reason: 'r' });
    const r = await call('eliminate_hypothesis', { hypothesisId: childIds[0], reason: 'again' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/already eliminated/);
    cleanup();
  });

  it('EL-12 explicit id pointing at supports record → Error', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 's' });
    await call('add_evidence', { hypothesisId: rootId, type: 'refutes', content: 'r' });
    // resolve the supports evidence id via get_tree full
    const full = await call('get_tree', { format: 'full' });
    const tree = JSON.parse(text(full));
    const rootH = tree.hypotheses[rootId];
    const sup = rootH.evidence.find((e: any) => e.type === 'supports');
    const r = await call('eliminate_hypothesis', { hypothesisId: rootId, reason: 'r', refutingEvidenceIds: [sup.id] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not a refutes-typed record/);
    cleanup();
  });
});

// ─────────────────────────── corroborate_hypothesis ───────────────────────────
describe('API: corroborate_hypothesis', () => {
  it('CR-01 single root corroborate → resolved, envelope sessionStatus', async () => {
    const { call, json, text, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 's' });
    const r = await call('corroborate_hypothesis', { hypothesisId: rootId, reason: 'found' });
    expect(json(r).sessionStatus).toBe('resolved');
    expect(text(r)).toContain('── Session resolved ──');
    cleanup();
  });

  it('CR-06 corroborate with pending child → Error unresolved children', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const { rootId } = await rootWithChildren(call, json, ['A', 'B']);
    const r = await call('corroborate_hypothesis', { hypothesisId: rootId, reason: 'r' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/unresolved children/);
    cleanup();
  });

  it('CR-13 corroborate with NO supporting evidence → SUCCESS (asymmetry)', async () => {
    const { call, json, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    const r = await call('corroborate_hypothesis', { hypothesisId: childIds[0], reason: 'r' });
    expect(r.isError).toBeFalsy();
    expect(json(r).status).toBe('corroborated');
    cleanup();
  });
});

// ─────────────────────────── set_out_of_scope ───────────────────────────
describe('API: set_out_of_scope', () => {
  it('OS-01 happy: child→out-of-scope', async () => {
    const { call, json, text, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    const r = await call('set_out_of_scope', { hypothesisId: childIds[0], reason: 'aside' });
    expect(json(r).status).toBe('out-of-scope');
    cleanup();
  });

  it('OS-05 oos the root → Error root-protection', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const r = await call('set_out_of_scope', { hypothesisId: json(c).rootId, reason: 'r' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/root/i);
    cleanup();
  });
});

// ─────────────────────────── score_hypothesis ───────────────────────────
describe('API: score_hypothesis', () => {
  it('SC-02/03 boundary 0 and 1 accepted', async () => {
    const { call, json, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    const r0 = await call('score_hypothesis', { hypothesisId: childIds[0], score: 0 });
    const r1 = await call('score_hypothesis', { hypothesisId: childIds[1], score: 1 });
    expect(json(r0).score).toBe(0);
    expect(json(r1).score).toBe(1);
    cleanup();
  });

  it('SC-08 score -0.1 → Validation error (Zod, not engine)', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    const r = await call('score_hypothesis', { hypothesisId: childIds[0], score: -0.1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Validation error:/);
    cleanup();
  });

  it('SC-10 score NaN → Validation error (Zod rejects, engine guard dead)', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    const r = await call('score_hypothesis', { hypothesisId: childIds[0], score: NaN });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Validation error:/);
    cleanup();
  });

  it('SC-14 score a terminal (eliminated) node → SUCCESS (no terminal guard)', async () => {
    const { call, json, text, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B']);
    await call('add_evidence', { hypothesisId: childIds[0], type: 'refutes', content: 'x' });
    await call('eliminate_hypothesis', { hypothesisId: childIds[0], reason: 'r' });
    const r = await call('score_hypothesis', { hypothesisId: childIds[0], score: 0.5 });
    expect(r.isError).toBeFalsy();
    expect(json(r).score).toBe(0.5);
    cleanup();
  });
});

// ─────────────────────────── get_tree ───────────────────────────
describe('API: get_tree', () => {
  it('GT-04 format:path silently renders compact (unimplemented enum)', async () => {
    const { call, text, json, cleanup } = makeHarness();
    await rootWithChildren(call, json, ['A', 'B']);
    const path = await call('get_tree', { format: 'path' });
    // path is accepted (not a validation error) and renders like compact
    expect(path.isError).toBeFalsy();
    expect(text(path)).toContain('Problem:');
    cleanup();
  });

  it('GT-05 no session → empty-state message', async () => {
    const { call, text, cleanup } = makeHarness();
    const r = await call('get_tree', {});
    expect(text(r)).toMatch(/No open session/);
    cleanup();
  });

  it('GT-06 resolved-only session → no active session for get_tree', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    await call('add_evidence', { hypothesisId: rootId, type: 'supports', content: 's' });
    await call('corroborate_hypothesis', { hypothesisId: rootId, reason: 'r' });
    const r = await call('get_tree', {});
    expect(text(r)).toMatch(/No open session/);
    cleanup();
  });
});

// ─────────────────────────── get_status ───────────────────────────
describe('API: get_status', () => {
  it('GS-01 progress breakdown after one elimination', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const { childIds } = await rootWithChildren(call, json, ['A', 'B', 'C']);
    await call('add_evidence', { hypothesisId: childIds[0], type: 'refutes', content: 'x' });
    await call('eliminate_hypothesis', { hypothesisId: childIds[0], reason: 'r' });
    const r = await call('get_status', {});
    expect(text(r)).toMatch(/Progress: \d+\/\d+ resolved/);
    expect(text(r)).toMatch(/1 eliminated/);
    cleanup();
  });

  it('GS-07 no session → empty state', async () => {
    const { call, text, cleanup } = makeHarness();
    const r = await call('get_status', {});
    expect(text(r)).toMatch(/No open session/);
    cleanup();
  });
});

// ─────────────────────────── validate_decomposition ───────────────────────────
describe('API: validate_decomposition', () => {
  it('VD-01 clean 3-way: advisories array, no pass/fail vocab', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const { rootId } = await rootWithChildren(call, json, ['Network', 'Application', 'Data']);
    const r = await call('validate_decomposition', { parentId: rootId });
    const t = text(r);
    expect(t).toContain('── Structural Checks ──');
    expect(t).not.toMatch(/\bPASS\b|\bFAIL\b|NEEDS_REVISION/);
    cleanup();
  });

  it('VD-08 nonexistent parent → Error', async () => {
    const { call, text, cleanup } = makeHarness();
    await call('create_tree', { problem: 'P' });
    const r = await call('validate_decomposition', { parentId: 'fake' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not found');
    cleanup();
  });
});

// ─────────────────────────── closure invariants ───────────────────────────
describe('API: closure invariants', () => {
  it('INV-01 corroboration under pruned ancestor does NOT resolve (abandoned)', async () => {
    const { call, json, sessionStatusFor, cleanup } = makeHarness();
    // root → [A, B]; decompose A → [A1, A2]; corroborate A1; oos A; oos B
    const { sessionId, childIds } = await rootWithChildren(call, json, ['A', 'B']);
    const [aId, bId] = childIds;
    const dA = await call('decompose', { parentId: aId, children: ['A1', 'A2'] });
    const [a1] = json(dA).childIds;
    await call('add_evidence', { hypothesisId: a1, type: 'supports', content: 's' });
    await call('corroborate_hypothesis', { hypothesisId: a1, reason: 'r' });
    await call('set_out_of_scope', { hypothesisId: aId, reason: 'aside' }); // prunes A (and A1 beneath)
    await call('set_out_of_scope', { hypothesisId: bId, reason: 'aside' });
    // all top-level branches pruned, corroboration is under a pruned ancestor
    expect(sessionStatusFor(sessionId)).toBe('abandoned');
    cleanup();
  });

  it('INV-02 corroboration on non-pruned lineage resolves', async () => {
    const { call, json, sessionStatusFor, cleanup } = makeHarness();
    const { sessionId, childIds } = await rootWithChildren(call, json, ['A', 'B']);
    const [aId, bId] = childIds;
    const dA = await call('decompose', { parentId: aId, children: ['A1', 'A2'] });
    const [a1, a2] = json(dA).childIds;
    await call('add_evidence', { hypothesisId: a1, type: 'refutes', content: 'x' });
    await call('eliminate_hypothesis', { hypothesisId: a1, reason: 'r' });
    await call('add_evidence', { hypothesisId: a2, type: 'supports', content: 's' });
    await call('corroborate_hypothesis', { hypothesisId: a2, reason: 'r' });
    await call('corroborate_hypothesis', { hypothesisId: aId, reason: 'r' });
    await call('add_evidence', { hypothesisId: bId, type: 'refutes', content: 'x' });
    await call('eliminate_hypothesis', { hypothesisId: bId, reason: 'r' });
    expect(sessionStatusFor(sessionId)).toBe('resolved');
    cleanup();
  });

  it('INV-06 mutating tools append tree summary; reads do not', async () => {
    const { call, text, json, cleanup } = makeHarness();
    const c = await call('create_tree', { problem: 'P' });
    const rootId = json(c).rootId;
    const dec = await call('decompose', { parentId: rootId, children: ['A', 'B'] });
    expect(text(dec)).toContain('── Tree ──');
    const gt = await call('get_tree', {});
    expect(text(gt)).not.toContain('── Tree ──');
    const gs = await call('get_status', {});
    expect(text(gs)).not.toContain('── Tree ──');
    cleanup();
  });
});
