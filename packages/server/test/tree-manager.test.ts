import { describe, it, expect, beforeEach } from 'vitest';
import { TreeManager, TreeError } from '../src/tree-manager.js';
import type { TreeEvent } from '../src/types.js';
import { TITLE_MAX_LENGTH } from '@tot-mcp/shared';

describe('TreeManager', () => {
  let tm: TreeManager;

  beforeEach(() => {
    tm = new TreeManager({ stagnationThreshold: 4 });
  });

  // --- Session creation ---

  describe('createSession', () => {
    it('creates a session with root hypothesis', () => {
      const { session, root } = tm.createSession('Why is the API slow?');
      expect(session.id).toBeDefined();
      expect(session.problem).toBe('Why is the API slow?');
      expect(session.status).toBe('open');
      expect(root.id).toBe(session.rootNodeId);
      expect(root.parentId).toBeNull();
      expect(root.depth).toBe(0);
      expect(root.status).toBe('pending');
      expect(root.title).toBe('Why is the API slow?');
    });

    it('rejects empty problem string', () => {
      expect(() => tm.createSession('')).toThrow(TreeError);
      expect(() => tm.createSession('   ')).toThrow(TreeError);
    });

    it('emits session-created and hypothesis-added events', () => {
      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      tm.createSession('Test');
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('session-created');
      expect(events[1].type).toBe('hypothesis-added');
    });
  });

  // --- Decompose ---

  describe('decompose', () => {
    it('creates child hypotheses under parent', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, [{ title: 'Cause A' }, { title: 'Cause B' }, { title: 'Cause C' }], { axis: 'by cause' });
      expect(children).toHaveLength(3);
      expect(children[0].parentId).toBe(root.id);
      expect(children[0].depth).toBe(1);
      expect(children[0].title).toBe('Cause A');
      expect(children[0].status).toBe('pending');
      expect(root.children).toHaveLength(3);
    });

    it('rejects fewer than 2 children', () => {
      const { root } = tm.createSession('Problem');
      expect(() => tm.decompose(root.id, [{ title: 'Only one' }], { axis: 'by cause' })).toThrow(TreeError);
    });

    it('rejects a whitespace-only child label', () => {
      // A blank-after-trim label is not a real hypothesis; it also degenerates
      // the validateDecomposition heuristics (substring includes('') matches
      // every sibling; word-count 0 makes abstractionMismatch fire spuriously).
      // Reject it at the engine boundary rather than storing it.
      const { root } = tm.createSession('Problem');
      expect(() => tm.decompose(root.id, [{ title: 'Real cause' }, { title: '   ' }], { axis: 'by cause' })).toThrow(/empty|blank|whitespace/i);
    });

    it('rejects decompose on eliminated hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'Not this');
      tm.eliminateHypothesis(root.id, 'Dead end');
      expect(() => tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' })).toThrow(TreeError);
    });

    it('rejects decompose on confirmed hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'This is it');
      tm.corroborateHypothesis(root.id, 'Confirmed');
      expect(() => tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' })).toThrow(TreeError);
    });

    it('rejects decompose on out-of-scope hypothesis', () => {
      // Decompose under a pruned ancestor would create children the closure
      // walker silently skips, leaving structural debt. Out-of-scope is a
      // pruning verdict and must reject decomposition the same as eliminated.
      const { root } = tm.createSession('Problem');
      const [a] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.setOutOfScope(a.id, 'set aside');
      expect(() => tm.decompose(a.id, [{ title: 'A1' }, { title: 'A2' }], { axis: 'by cause' })).toThrow(TreeError);
    });

    it('rejects non-existent parent', () => {
      tm.createSession('Problem');
      expect(() => tm.decompose('fake-id', [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' })).toThrow(TreeError);
    });

    it('supports deep nesting', () => {
      const { root } = tm.createSession('Problem');
      const level1 = tm.decompose(root.id, [{ title: 'L1A' }, { title: 'L1B' }], { axis: 'by cause' });
      const level2 = tm.decompose(level1[0].id, [{ title: 'L2A' }, { title: 'L2B' }], { axis: 'by cause' });
      const level3 = tm.decompose(level2[0].id, [{ title: 'L3A' }, { title: 'L3B' }], { axis: 'by cause' });
      expect(level3[0].depth).toBe(3);
    });

    it('emits hypothesis-added for each child', () => {
      const { root } = tm.createSession('Problem');
      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { axis: 'by cause' });
      const added = events.filter((e) => e.type === 'hypothesis-added');
      expect(added).toHaveLength(3);
    });
  });

  // --- Add Hypothesis ---

  describe('addHypothesis', () => {
    it('adds a single child hypothesis', () => {
      const { root } = tm.createSession('Problem');
      const h = tm.addHypothesis(root.id, { title: 'New idea' });
      expect(h.parentId).toBe(root.id);
      expect(h.title).toBe('New idea');
      expect(h.status).toBe('pending');
      expect(root.children).toContain(h.id);
    });

    it('rejects when parent is eliminated', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'nope');
      tm.eliminateHypothesis(root.id, 'dead');
      expect(() => tm.addHypothesis(root.id, { title: 'Too late' })).toThrow(TreeError);
    });

    it('rejects a whitespace-only content', () => {
      const { root } = tm.createSession('Problem');
      expect(() => tm.addHypothesis(root.id, { title: '   ' })).toThrow(/empty|blank|whitespace/i);
    });

    it('rejects when parent is corroborated', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'good');
      tm.corroborateHypothesis(root.id, 'done');
      expect(() => tm.addHypothesis(root.id, { title: 'Too late' })).toThrow(TreeError);
    });

    it('rejects when parent is out-of-scope', () => {
      const { root } = tm.createSession('Problem');
      const [a] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.setOutOfScope(a.id, 'set aside');
      expect(() => tm.addHypothesis(a.id, { title: 'Late add' })).toThrow(TreeError);
    });

    it('rejects non-existent parent', () => {
      tm.createSession('Problem');
      expect(() => tm.addHypothesis('fake', { title: 'Nope' })).toThrow(TreeError);
    });
  });

  // --- Add Evidence ---

  describe('addEvidence', () => {
    it('adds evidence and returns it', () => {
      const { root } = tm.createSession('Problem');
      const { evidence: ev } = tm.addEvidence(root.id, 'supports', 'Log shows error', 'app.log');
      expect(ev.type).toBe('supports');
      expect(ev.content).toBe('Log shows error');
      expect(ev.source).toBe('app.log');
      expect(root.evidence).toHaveLength(1);
    });

    it('rejects whitespace-only evidence content', () => {
      const { root } = tm.createSession('Problem');
      expect(() => tm.addEvidence(root.id, 'supports', '   ')).toThrow(/empty|blank|whitespace/i);
    });

    it('auto-transitions pending to exploring on first evidence', () => {
      const { root } = tm.createSession('Problem');
      expect(root.status).toBe('pending');
      tm.addEvidence(root.id, 'supports', 'First evidence');
      expect(root.status).toBe('exploring');
    });

    it('does not re-transition on subsequent evidence', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'First');
      tm.addEvidence(root.id, 'refutes', 'Second');
      expect(root.status).toBe('exploring');
    });

    it('rejects evidence on eliminated hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'Bad');
      tm.eliminateHypothesis(root.id, 'Done');
      expect(() => tm.addEvidence(root.id, 'supports', 'Too late')).toThrow(TreeError);
    });

    it('rejects evidence on confirmed hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'Good');
      tm.corroborateHypothesis(root.id, 'Found it');
      expect(() => tm.addEvidence(root.id, 'neutral', 'Extra')).toThrow(TreeError);
    });

    it('rejects non-existent hypothesis', () => {
      tm.createSession('Problem');
      expect(() => tm.addEvidence('fake', 'supports', 'Nope')).toThrow(TreeError);
    });

    it('emits evidence-added and hypothesis-updated events', () => {
      const { root } = tm.createSession('Problem');
      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      tm.addEvidence(root.id, 'supports', 'Data');
      expect(events.some((e) => e.type === 'evidence-added')).toBe(true);
      expect(events.some((e) => e.type === 'hypothesis-updated')).toBe(true);
    });
  });

  // --- Eliminate ---

  describe('eliminateHypothesis', () => {
    it('sets status to eliminated with conclusion', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'Not this');
      const result = tm.eliminateHypothesis(root.id, 'Evidence refutes');
      expect(result.status).toBe('eliminated');
      expect(result.conclusion?.verdict).toBe('eliminated');
      expect(result.conclusion?.reason).toBe('Evidence refutes');
    });

    it('rejects already eliminated', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'Bad');
      tm.eliminateHypothesis(root.id, 'Done');
      expect(() => tm.eliminateHypothesis(root.id, 'Again')).toThrow(TreeError);
    });

    it('rejects a whitespace-only reason (every verdict must carry an audit justification)', () => {
      const mk = () => tm.createSession('Problem').root;
      const a = mk();
      tm.addEvidence(a.id, 'refutes', 'r');
      expect(() => tm.eliminateHypothesis(a.id, '   ')).toThrow(/empty|blank|whitespace/i);
      const b = mk();
      tm.addEvidence(b.id, 'supports', 's');
      expect(() => tm.corroborateHypothesis(b.id, '   ')).toThrow(/empty|blank|whitespace/i);
      const { root: parent } = tm.createSession('Parent');
      const [child] = tm.decompose(parent.id, [{ title: 'C1' }, { title: 'C2' }], { axis: 'by cause' });
      expect(() => tm.setOutOfScope(child.id, '  ')).toThrow(/empty|blank|whitespace/i);
    });

    it('rejects eliminating a confirmed hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'Good');
      tm.corroborateHypothesis(root.id, 'Found');
      expect(() => tm.eliminateHypothesis(root.id, 'Changed mind')).toThrow(TreeError);
    });

    it('emits hypothesis-updated event', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'Bad');
      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      tm.eliminateHypothesis(root.id, 'Done');
      expect(events[0].type).toBe('hypothesis-updated');
    });
  });

  // --- Corroborate ---

  describe('corroborateHypothesis', () => {
    it('sets status to corroborated with conclusion and resolves session', () => {
      const { session, root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'Evidence');
      const result = tm.corroborateHypothesis(root.id, 'Root cause found');
      expect(result.status).toBe('corroborated');
      expect(result.conclusion?.verdict).toBe('corroborated');
      expect(session.status).toBe('resolved');
    });

    it('rejects corroborating an eliminated hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'Bad');
      tm.eliminateHypothesis(root.id, 'Done');
      expect(() => tm.corroborateHypothesis(root.id, 'Wait')).toThrow(TreeError);
    });

    it('rejects already corroborated', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'Good');
      tm.corroborateHypothesis(root.id, 'Found');
      expect(() => tm.corroborateHypothesis(root.id, 'Again')).toThrow(TreeError);
    });

    it('emits hypothesis-updated and session-completed events', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'Good');
      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      tm.corroborateHypothesis(root.id, 'Found');
      expect(events.some((e) => e.type === 'hypothesis-updated')).toBe(true);
      expect(events.some((e) => e.type === 'session-completed')).toBe(true);
    });

    it('rejects corroborating a parent while a child is pending', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      expect(() => tm.corroborateHypothesis(root.id, 'reason')).toThrow(TreeError);
    });

    it('rejects corroborating a parent while a child is exploring', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(children[0].id, 'supports', 'note');
      expect(children[0].status).toBe('exploring');
      tm.addEvidence(children[1].id, 'refutes', 'no');
      tm.eliminateHypothesis(children[1].id, 'reason');
      expect(() => tm.corroborateHypothesis(root.id, 'reason')).toThrow(TreeError);
    });

    it('corroborates a parent once every child is resolved', () => {
      // Corroborate an intermediate parent P after both of P's children resolve,
      // while a sibling top-level branch (Q) keeps the session open — so this
      // exercises the child-terminality gate, not the closed-session path.
      const { session, root } = tm.createSession('Problem');
      const [p] = tm.decompose(root.id, [{ title: 'P' }, { title: 'Q' }], { axis: 'by cause' });
      const [a, b] = tm.decompose(p.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(a.id, 'refutes', 'no');
      tm.eliminateHypothesis(a.id, 'reason');
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'reason');
      const result = tm.corroborateHypothesis(p.id, 'reason');
      expect(result.status).toBe('corroborated');
      expect(session.status).toBe('open'); // Q still pending
    });

    it('refuses to corroborate a parent with a dangling (missing) child id', () => {
      // Simulate an incompletely-loaded tree (e.g. a corrupt/skipped journal
      // line dropped one child) by replaying a parent that lists a child id
      // the manager never loaded. A missing child must fail closed, not be
      // treated as satisfied.
      const loadTm = new TreeManager({});
      const now = new Date().toISOString();
      const session = { id: 'sx', problem: 'P', rootNodeId: 'root', status: 'open' as const, createdAt: now };
      const root = {
        id: 'root', parentId: null, sessionId: 'sx', depth: 0, title: 'P',
        status: 'exploring' as const, evidence: [],
        metadata: { createdAt: now, updatedAt: now, source: 'agent' as const },
        children: ['present', 'missing'],
      };
      const present = {
        id: 'present', parentId: 'root', sessionId: 'sx', depth: 1, title: 'present child',
        status: 'eliminated' as const,
        conclusion: { verdict: 'eliminated' as const, reason: 'r', timestamp: now },
        evidence: [{ id: 'e', type: 'refutes' as const, content: 'x', timestamp: now }],
        metadata: { createdAt: now, updatedAt: now, source: 'agent' as const },
        children: [],
      };
      // 'missing' is intentionally NOT loaded.
      loadTm.loadState([session], [root, present]);
      expect(() => loadTm.corroborateHypothesis('root', 'should fail')).toThrow(/unresolved or missing children/);
    });
  });

  // --- Spine closure ---

  describe('session resolution (spine closure)', () => {
    it('corroborating one top-level branch leaves the session open while siblings are still pending', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A survives');
      expect(a.status).toBe('corroborated');
      expect(b.status).toBe('pending');
      expect(session.status).toBe('open');
    });

    it('resolves once every top-level branch is terminal', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A survives');
      expect(session.status).toBe('resolved');
    });

    it('admits multiple corroborated leaves at the same level (INUS)', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(a.id, 'supports', 'a');
      tm.corroborateHypothesis(a.id, 'A');
      expect(session.status).toBe('open');
      tm.addEvidence(b.id, 'supports', 'b');
      tm.corroborateHypothesis(b.id, 'B');
      expect(a.status).toBe('corroborated');
      expect(b.status).toBe('corroborated');
      expect(session.status).toBe('resolved');
    });

    it('out-of-scope dispenses with a branch as pruning, allowing closure', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.setOutOfScope(b.id, 'not investigating');
      expect(b.status).toBe('out-of-scope');
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A survives');
      expect(session.status).toBe('resolved');
    });

    it('refuting evidence on a corroborated leaf reopens the session', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A');
      expect(session.status).toBe('resolved');

      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      tm.addEvidence(a.id, 'refutes', 'wait, found a counter-instance');
      expect(session.status).toBe('open');
      expect(events.some((e) => e.type === 'session-reopened')).toBe(true);
      // The leaf is demoted to 'exploring' so closure can re-evaluate
      // honestly under the new evidence; the historical conclusion stays
      // in the audit trail with supersededBy='self' marking the direct
      // refute.
      expect(a.status).toBe('exploring');
      expect(a.conclusion?.verdict).toBe('corroborated');
      expect(a.conclusion?.supersededBy).toBe('self');
      // Direct refute on a leaf has no cascade: exactly one hypothesis-updated
      // (for the target) fires, alongside session-reopened.
      expect(events.filter((e) => e.type === 'hypothesis-updated').length).toBe(1);
    });

    it('refuting evidence on a corroborated leaf reopens an abandoned session as well', () => {
      // Both terminal states (resolved and abandoned) reflect a claimed
      // closure that fresh refutation challenges; either reopens. Concrete
      // path to abandoned-with-buried-corroboration: corroborate A2 under
      // A, eliminate A, eliminate B → no live corroboration on a non-pruned
      // lineage → session abandons. A2 stays corroborated.
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      const [a1, a2] = tm.decompose(a.id, [{ title: 'A1' }, { title: 'A2' }], { axis: 'by cause' });
      tm.addEvidence(a1.id, 'refutes', 'no');
      tm.eliminateHypothesis(a1.id, 'gone');
      tm.addEvidence(a2.id, 'supports', 'good');
      tm.corroborateHypothesis(a2.id, 'A2 wins');
      tm.addEvidence(a.id, 'refutes', 'overall A is wrong');
      tm.eliminateHypothesis(a.id, 'A pruned');
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'gone');
      expect(session.status).toBe('abandoned');

      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      tm.addEvidence(a2.id, 'refutes', 'counter-instance');
      expect(session.status).toBe('open');
      expect(events.some((e) => e.type === 'session-reopened')).toBe(true);
      // The leaf is demoted to 'exploring' so closure can re-evaluate
      // honestly under the new evidence; the historical conclusion stays
      // in the audit trail with supersededBy='self' marking the direct
      // refute (mirrors the resolved-session sibling above).
      expect(a2.status).toBe('exploring');
      expect(a2.conclusion?.verdict).toBe('corroborated');
      expect(a2.conclusion?.supersededBy).toBe('self');
    });

    it('cascades demotion up corroborated ancestors when a corroborated child is refuted', () => {
      // The corroboration gate requires every child terminal at the moment
      // of the verdict. When a corroborated descendant later demotes via
      // refute, the ancestor's verdict is no longer earned — the demote
      // must climb the corroborated spine until it reaches a non-
      // corroborated parent.
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      const [a1, a2] = tm.decompose(a.id, [{ title: 'A1' }, { title: 'A2' }], { axis: 'by cause' });
      tm.addEvidence(a1.id, 'refutes', 'no');
      tm.eliminateHypothesis(a1.id, 'gone');
      tm.addEvidence(a2.id, 'supports', 'good');
      tm.corroborateHypothesis(a2.id, 'A2 wins');
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A wins via A2');
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'gone');
      expect(session.status).toBe('resolved');
      expect(a.status).toBe('corroborated');
      expect(a2.status).toBe('corroborated');
      // Refute A2 — A2 demotes, and A's verdict is no longer earned, so A
      // also demotes. Session reopens.
      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      const { demotedAncestors } = tm.addEvidence(a2.id, 'refutes', 'counter-instance');
      expect(a2.status).toBe('exploring');
      expect(a.status).toBe('exploring');
      expect(session.status).toBe('open');
      // Audit trail intact on both ancestors, with supersededBy distinguishing
      // the direct refute from the cascade.
      expect(a2.conclusion?.verdict).toBe('corroborated');
      expect(a2.conclusion?.supersededBy).toBe('self');
      expect(a.conclusion?.verdict).toBe('corroborated');
      expect(a.conclusion?.supersededBy).toBe('descendant');
      // The cascade returns demoted ancestors so the tools handler can
      // journal each one for replay parity.
      expect(demotedAncestors.map((h) => h.id)).toEqual([a.id]);
      // Event ordering: target hypothesis-updated fires first, then
      // session-reopened, then the cascade emits ancestor
      // hypothesis-updated. SSE consumers never see ancestors demoted
      // under a still-resolved session.
      const targetUpdateIdx = events.findIndex(
        (e) => e.type === 'hypothesis-updated' && e.hypothesis.id === a2.id,
      );
      const reopenIdx = events.findIndex((e) => e.type === 'session-reopened');
      const ancestorUpdateIdx = events.findIndex(
        (e) => e.type === 'hypothesis-updated' && e.hypothesis.id === a.id,
      );
      expect(targetUpdateIdx).toBeGreaterThanOrEqual(0);
      expect(reopenIdx).toBeGreaterThan(targetUpdateIdx);
      expect(ancestorUpdateIdx).toBeGreaterThan(reopenIdx);
    });

    it('rejects supports/neutral evidence on a corroborated leaf', () => {
      const { root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A');
      expect(() => tm.addEvidence(a.id, 'supports', 'more')).toThrow(TreeError);
      expect(() => tm.addEvidence(a.id, 'neutral', 'extra')).toThrow(TreeError);
    });

    it('does not resolve when a pending grandchild hides under an eliminated intermediate of a corroborated branch', () => {
      // Closure walker must descend through pruned intermediates because
      // elimination does not cascade — a pending grandchild can legally
      // sit below an eliminated parent on a corroborated lineage.
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      const [a1, a2] = tm.decompose(a.id, [{ title: 'A1' }, { title: 'A2' }], { axis: 'by cause' });
      tm.decompose(a1.id, [{ title: 'A1a' }, { title: 'A1b' }], { axis: 'by cause' });  // A1a, A1b pending
      tm.addEvidence(a1.id, 'refutes', 'no');
      tm.eliminateHypothesis(a1.id, 'no');
      tm.addEvidence(a2.id, 'refutes', 'no');
      tm.eliminateHypothesis(a2.id, 'no');
      tm.corroborateHypothesis(a.id, 'A survives');
      expect(session.status).toBe('open');
    });

    it('does not resolve when a pending grandchild hides under an out-of-scope intermediate of a corroborated branch', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      const [a1, a2] = tm.decompose(a.id, [{ title: 'A1' }, { title: 'A2' }], { axis: 'by cause' });
      tm.decompose(a1.id, [{ title: 'A1a' }, { title: 'A1b' }], { axis: 'by cause' });
      tm.setOutOfScope(a1.id, 'set aside');
      tm.addEvidence(a2.id, 'refutes', 'no');
      tm.eliminateHypothesis(a2.id, 'no');
      tm.corroborateHypothesis(a.id, 'A survives');
      expect(session.status).toBe('open');
    });

    it('clears completedAt when a corroborated leaf is reopened by refutation', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A');
      expect(session.completedAt).toBeDefined();
      tm.addEvidence(a.id, 'refutes', 'counter-instance');
      expect(session.status).toBe('open');
      expect(session.completedAt).toBeUndefined();
    });

    it('resolves when set_out_of_scope completes the disposition of the last open top-level branch', () => {
      // Closure check must fire from setOutOfScope, not only from corroborate.
      const { session, root } = tm.createSession('Problem');
      const [a, b, c] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { axis: 'by cause' });
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A survives');
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      expect(session.status).toBe('open');
      tm.setOutOfScope(c.id, 'set aside');
      expect(session.status).toBe('resolved');
    });

    it('resolves when an elimination completes the disposition of the last open top-level branch', () => {
      // Closure check must fire from eliminate, not only from corroborate.
      const { session, root } = tm.createSession('Problem');
      const [a, b, c] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { axis: 'by cause' });
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A survives');
      tm.setOutOfScope(b.id, 'set aside');
      expect(session.status).toBe('open');
      tm.addEvidence(c.id, 'refutes', 'no');
      tm.eliminateHypothesis(c.id, 'no');
      expect(session.status).toBe('resolved');
    });

    it('does not count a corroboration buried under a pruned top-level branch as survival', () => {
      // A corroborated grandchild under an out-of-scope or eliminated
      // top-level branch is moot under the same pruning rule the closure
      // walker applies. With every top-level pruned and no surviving
      // answer on a non-pruned lineage, the session abandons.
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      const [a1] = tm.decompose(a.id, [{ title: 'A1' }, { title: 'A2' }], { axis: 'by cause' });
      tm.addEvidence(a1.id, 'supports', 'good');
      tm.corroborateHypothesis(a1.id, 'A1 survives');
      tm.setOutOfScope(a.id, 'set aside');
      tm.setOutOfScope(b.id, 'set aside');
      expect(session.status).toBe('abandoned');
    });

    it('abandons when every top-level is pruned and no corroboration survives on a non-pruned lineage', () => {
      // Mix of eliminated and out-of-scope, no corroborated answer — the
      // session has no live work and no surviving answer, so the only
      // honest disposition is abandonment.
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(a.id, 'refutes', 'no');
      tm.eliminateHypothesis(a.id, 'no');
      tm.setOutOfScope(b.id, 'set aside');
      expect(session.status).toBe('abandoned');
    });

    it('abandons when every top-level branch is set out-of-scope', () => {
      // Pure out-of-scope disposition: no corroboration, no elimination.
      // The session has been wholly set aside; the closure rule must
      // recognise this as abandonment, not leave the session stuck open.
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.setOutOfScope(a.id, 'set aside');
      expect(session.status).toBe('open');
      tm.setOutOfScope(b.id, 'set aside');
      expect(session.status).toBe('abandoned');
    });

    it('resolves a deeply corroborated branch when every leaf is terminal', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      const [a1, a2] = tm.decompose(a.id, [{ title: 'A1' }, { title: 'A2' }], { axis: 'by cause' });
      tm.addEvidence(a1.id, 'refutes', 'no');
      tm.eliminateHypothesis(a1.id, 'no');
      tm.addEvidence(a2.id, 'refutes', 'no');
      tm.eliminateHypothesis(a2.id, 'no');
      tm.corroborateHypothesis(a.id, 'A survives by elimination');
      expect(session.status).toBe('resolved');
    });
  });

  describe('closed-session mutation guard', () => {
    // Pruning (eliminate/out-of-scope) never cascades, so a closed session can
    // retain pending/exploring descendants under a pruned branch. Mutating those
    // leaked nodes must be rejected: a resolved/abandoned investigation is not a
    // live workspace, and silently mutating it (especially corroborating a leaked
    // node, which would never re-run closure) leaves the verdict inconsistent.
    // The one sanctioned way to act on a closed session is a refute that reopens
    // it — covered by the spine-closure reopen tests.

    /** Builds a session resolved with a pending grandchild leaked under pruned A. */
    function resolvedWithLeakedPending() {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      const [a1] = tm.decompose(a.id, [{ title: 'A1' }, { title: 'A2' }], { axis: 'by cause' }); // A1, A2 pending under A
      // Prune A and B without resolving A1/A2 (elimination does not cascade).
      tm.addEvidence(a.id, 'refutes', 'A wrong');
      tm.eliminateHypothesis(a.id, 'A pruned');
      tm.addEvidence(b.id, 'supports', 'good');
      tm.corroborateHypothesis(b.id, 'B survives');
      expect(session.status).toBe('resolved');
      expect(a1.status).toBe('pending'); // leaked: still pending in a closed session
      return { session, a1 };
    }

    it('rejects add_evidence on a leaked pending node in a resolved session', () => {
      const { a1 } = resolvedWithLeakedPending();
      expect(() => tm.addEvidence(a1.id, 'supports', 'late evidence')).toThrow(TreeError);
      expect(() => tm.addEvidence(a1.id, 'supports', 'late evidence')).toThrow(/resolved|closed|completed/i);
    });

    it('rejects decompose on a leaked pending node in a resolved session', () => {
      const { a1 } = resolvedWithLeakedPending();
      expect(() => tm.decompose(a1.id, [{ title: 'X' }, { title: 'Y' }], { axis: 'by cause' })).toThrow(/resolved|closed|completed/i);
    });

    it('rejects add_hypothesis on a leaked pending node in a resolved session', () => {
      const { a1 } = resolvedWithLeakedPending();
      expect(() => tm.addHypothesis(a1.id, { title: 'Z' })).toThrow(/resolved|closed|completed/i);
    });

    it('rejects corroborate on a leaked node in a resolved session (prevents stale verdict)', () => {
      const { session, a1 } = resolvedWithLeakedPending();
      // A1 has no children, so it would otherwise be corroborable; doing so in a
      // closed session is exactly the stale-verdict path — the close-check is
      // gated on open, so tryCloseSession would never reconcile.
      expect(() => tm.corroborateHypothesis(a1.id, 'late')).toThrow(/resolved|closed|completed/i);
      expect(session.status).toBe('resolved'); // unchanged
    });

    it('still allows a refute that reopens the session (sanctioned path)', () => {
      // Regression guard: the closed-session block must not break the legitimate
      // reopen path. Refuting the corroborated branch reopens, then the now-open
      // session accepts further mutation.
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A');
      expect(session.status).toBe('resolved');

      // Refute on the corroborated leaf reopens (sanctioned), then a follow-up
      // mutation on the reopened session is accepted.
      tm.addEvidence(a.id, 'refutes', 'counter-instance');
      expect(session.status).toBe('open');
      expect(() => tm.addEvidence(a.id, 'neutral', 'more context')).not.toThrow();
    });
  });

  describe('eliminateHypothesis evidence binding', () => {
    it('rejects elimination without recorded refuting evidence and without explicit ids', () => {
      const { root } = tm.createSession('Problem');
      expect(() => tm.eliminateHypothesis(root.id, 'gut feeling')).toThrow(
        /add_evidence\(type=refutes\).+set_out_of_scope/,
      );
    });

    it('binds all refutes-typed records when no explicit ids are passed', () => {
      const { root } = tm.createSession('Problem');
      const { evidence: e1 } = tm.addEvidence(root.id, 'refutes', 'r1');
      const { evidence: e2 } = tm.addEvidence(root.id, 'refutes', 'r2');
      tm.addEvidence(root.id, 'neutral', 'n');
      const result = tm.eliminateHypothesis(root.id, 'multiple refutations');
      expect(result.conclusion?.refutingEvidenceIds).toEqual([e1.id, e2.id]);
    });

    it('binds explicit ids when supplied', () => {
      const { root } = tm.createSession('Problem');
      const { evidence: e1 } = tm.addEvidence(root.id, 'refutes', 'r1');
      tm.addEvidence(root.id, 'refutes', 'r2');
      const result = tm.eliminateHypothesis(root.id, 'just one is decisive', [e1.id]);
      expect(result.conclusion?.refutingEvidenceIds).toEqual([e1.id]);
    });

    it('rejects explicit ids that reference non-refutes records', () => {
      const { root } = tm.createSession('Problem');
      const { evidence: supports } = tm.addEvidence(root.id, 'supports', 'irrelevant here');
      tm.addEvidence(root.id, 'refutes', 'real refute');
      expect(() => tm.eliminateHypothesis(root.id, 'wrong id', [supports.id])).toThrow(
        /not a refutes-typed record/,
      );
    });
  });

  describe('setOutOfScope', () => {
    it('marks a hypothesis terminal with verdict out-of-scope', () => {
      const { root } = tm.createSession('Problem');
      const [a] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      const result = tm.setOutOfScope(a.id, 'set aside');
      expect(result.status).toBe('out-of-scope');
      expect(result.conclusion?.verdict).toBe('out-of-scope');
    });

    it('rejects setting the root hypothesis out-of-scope', () => {
      const { root } = tm.createSession('Problem');
      expect(() => tm.setOutOfScope(root.id, 'abandon entire investigation')).toThrow(TreeError);
    });

    it('rejects setting a terminal hypothesis out-of-scope', () => {
      const { root } = tm.createSession('Problem');
      const [a] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(a.id, 'refutes', 'no');
      tm.eliminateHypothesis(a.id, 'gone');
      expect(() => tm.setOutOfScope(a.id, 'too late')).toThrow(TreeError);
    });
  });

  // --- Validate Decomposition ---

  describe('validateDecomposition', () => {
    it('returns structural checks for children', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, [{ title: 'Network issue' }, { title: 'Application bug' }, { title: 'Data corruption' }], { axis: 'by cause' });
      const check = tm.validateDecomposition(root.id);
      expect(check.childCount).toBe(3);
      expect(check.substringOverlaps).toHaveLength(0);
      expect(check.duplicateLabels).toHaveLength(0);
      expect(check.hasCatchAll).toBe(false);
    });

    it('detects substring overlap', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, [{ title: 'Network error' }, { title: 'Network' }], { axis: 'by cause' });
      const check = tm.validateDecomposition(root.id);
      expect(check.substringOverlaps.length).toBeGreaterThan(0);
    });

    it('detects catch-all category', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, [{ title: 'Known issue' }, { title: 'Other' }], { axis: 'by cause' });
      const check = tm.validateDecomposition(root.id);
      expect(check.hasCatchAll).toBe(true);
    });

    it('detects duplicate labels', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, [{ title: 'Same thing' }, { title: 'Same thing' }, { title: 'Different' }], { axis: 'by cause' });
      const check = tm.validateDecomposition(root.id);
      expect(check.duplicateLabels).toContain('same thing');
    });

    it('rejects non-existent parent', () => {
      tm.createSession('Problem');
      expect(() => tm.validateDecomposition('fake')).toThrow(TreeError);
    });

    it('ignores incidental whitespace when counting words for abstraction mismatch', () => {
      // 'database is slow' is 3 words; a leading space must not inflate it to
      // 4 and trip the maxLen > minLen*3 heuristic against the 1-word sibling.
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, [{ title: ' database is slow' }, { title: 'cache' }], { axis: 'by cause' });
      const check = tm.validateDecomposition(root.id);
      expect(check.abstractionMismatch).toBe(false);
      expect(check.minWords).toBe(1);
      expect(check.maxWords).toBe(3);
    });

    it('flags a genuine abstraction mismatch (>3x word span)', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, [{ title: 'the database query plan regressed badly' }, { title: 'cache' }], { axis: 'by cause' });
      const check = tm.validateDecomposition(root.id);
      expect(check.abstractionMismatch).toBe(true);
    });
  });

  // --- Get Tree ---

  describe('getTree', () => {
    it('returns active session state', () => {
      const { session } = tm.createSession('Problem');
      const state = tm.getTree();
      expect(state).not.toBeNull();
      expect(state!.session.id).toBe(session.id);
      expect(state!.hypotheses.size).toBe(1);
    });

    it('returns null when no sessions exist', () => {
      expect(tm.getTree()).toBeNull();
    });

    it('returns specific session by ID', () => {
      const { session: s1 } = tm.createSession('First');
      tm.addEvidence(s1.rootNodeId, 'supports', 'x');
      tm.corroborateHypothesis(s1.rootNodeId, 'done');
      tm.createSession('Second');
      const state = tm.getTree(s1.id);
      expect(state!.session.id).toBe(s1.id);
    });
  });

  // --- Get Status ---

  describe('getStatus', () => {
    it('returns counts and progress', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { axis: 'by cause' });
      tm.addEvidence(children[0].id, 'refutes', 'Bad');
      tm.eliminateHypothesis(children[0].id, 'Done');

      const status = tm.getStatus();
      expect(status.counts.eliminated).toBe(1);
      // B + C = 2 pending (root auto-transitioned to exploring on decompose, A was exploring then eliminated)
      expect(status.counts.pending).toBe(2);
      expect(status.counts.exploring).toBe(1);
      expect(status.unexplored).toHaveLength(2);
    });

    it('returns null session when no sessions', () => {
      const status = tm.getStatus();
      expect(status.session).toBeNull();
    });

    it('reports unexplored pending hypotheses', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      const status = tm.getStatus();
      const unexploredIds = status.unexplored.map((u) => u.id).sort();
      expect(unexploredIds).toEqual([children[0].id, children[1].id].sort());
    });

    it('drops a hypothesis from unexplored once it has evidence', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(children[0].id, 'supports', 'data'); // pending -> exploring
      const status = tm.getStatus();
      expect(status.unexplored.map((u) => u.id)).toEqual([children[1].id]);
    });
  });

  // --- Stagnation Detection ---

  describe('stagnation', () => {
    it('is not stagnant initially', () => {
      tm.createSession('Problem');
      expect(tm.getStatus().stagnant).toBe(false);
    });

    it('becomes stagnant after threshold mutations without status change', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      // First evidence flips pending->exploring (resets the counter); the
      // next four are same-status mutations that accumulate to the threshold.
      tm.addEvidence(children[0].id, 'neutral', 'n0');
      tm.addEvidence(children[0].id, 'neutral', 'n1');
      tm.addEvidence(children[0].id, 'neutral', 'n2');
      tm.addEvidence(children[0].id, 'neutral', 'n3');
      tm.addEvidence(children[0].id, 'neutral', 'n4');
      expect(tm.getStatus().stagnant).toBe(true);
    });

    it('resets after a status change', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      for (let i = 0; i < 5; i++) tm.addEvidence(children[0].id, 'neutral', `n${i}`);
      expect(tm.getStatus().stagnant).toBe(true);
      // A real status change (eliminating a different sibling) resets it.
      tm.addEvidence(children[1].id, 'refutes', 'no');
      tm.eliminateHypothesis(children[1].id, 'gone');
      expect(tm.getStatus().stagnant).toBe(false);
    });

    it('reopen-on-refute resets the stagnation counter (session-level transition is real progress)', () => {
      // Resolve session A via corroborate+eliminate. Open a second session B
      // so getActiveSession has a fallback (A is no longer open and would
      // otherwise hide from getStatus). Reproduce stagnation on B via
      // no-op scoring, then refute A's corroborated leaf — A reopens AND
      // the counter must reset so the next get_status on B does not
      // falsely warn about stagnation produced by unrelated activity.
      const { session: sessionA, root: rootA } = tm.createSession('Problem A');
      const [a, bA] = tm.decompose(rootA.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      tm.addEvidence(a.id, 'supports', 'good');
      tm.corroborateHypothesis(a.id, 'A survives');
      tm.addEvidence(bA.id, 'refutes', 'no');
      tm.eliminateHypothesis(bA.id, 'gone');
      expect(sessionA.status).toBe('resolved');

      // Open session B and bump its stagnation counter via same-status
      // neutral evidence (first flips pending->exploring, rest accumulate).
      const { root: rootB } = tm.createSession('Problem B');
      const [b1] = tm.decompose(rootB.id, [{ title: 'B1' }, { title: 'B2' }], { axis: 'by cause' });
      for (let i = 0; i < 5; i++) tm.addEvidence(b1.id, 'neutral', `n${i}`);
      expect(tm.getStatus().stagnant).toBe(true);

      // Refute A's corroborated leaf — sessionA reopens, becomes current, and
      // its own (reset) stagnation counter is what get_status now reports.
      tm.addEvidence(a.id, 'refutes', 'counter-instance');
      expect(sessionA.status).toBe('open');
      expect(tm.getStatus().stagnant).toBe(false);
    });

    it('setOutOfScope resets the stagnation counter (it is real disposition progress)', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { axis: 'by cause' });
      for (let i = 0; i < 5; i++) tm.addEvidence(children[0].id, 'neutral', `n${i}`);
      expect(tm.getStatus().stagnant).toBe(true);
      tm.setOutOfScope(children[1].id, 'set aside');
      expect(tm.getStatus().stagnant).toBe(false);
    });

    it('tracks stagnation per session — churn on B does not mark A stagnant', () => {
      // Two co-open sessions in one manager. Session A has had a real status
      // change and zero churn; session B accumulates same-status mutations.
      // get_status for A must report stagnant=false: each session's counter
      // is isolated, so B's churn cannot contaminate A's verdict.
      const { session: sessionA, root: rootA } = tm.createSession('Problem A');
      const [a1] = tm.decompose(rootA.id, [{ title: 'A1' }, { title: 'A2' }], { axis: 'by cause' });
      tm.addEvidence(a1.id, 'supports', 'real status change on A');

      const { root: rootB } = tm.createSession('Problem B');
      const [b1] = tm.decompose(rootB.id, [{ title: 'B1' }, { title: 'B2' }], { axis: 'by cause' });
      for (let i = 0; i < 5; i++) tm.addEvidence(b1.id, 'neutral', `n${i}`);

      // B is the active session (last mutated) and is stagnant.
      expect(tm.getStatus().stagnant).toBe(true);
      // Resolve the active pointer back to A and confirm A is NOT stagnant.
      tm.addEvidence(a1.id, 'supports', 'more on A');
      expect(tm.getStatus().session?.id).toBe(sessionA.id);
      expect(tm.getStatus().stagnant).toBe(false);
    });
  });

  // --- Load State ---

  describe('loadState', () => {
    it('restores sessions and hypotheses', () => {
      const { session, root } = tm.createSession('Original');
      const children = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });

      const tm2 = new TreeManager();
      tm2.loadState(
        [session],
        [root, ...children],
      );

      const state = tm2.getTree();
      expect(state).not.toBeNull();
      expect(state!.session.id).toBe(session.id);
      expect(state!.hypotheses.size).toBe(3);
    });
  });

  // --- Siblings ---

  describe('getSiblings', () => {
    it('returns sibling hypotheses', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { axis: 'by cause' });
      const siblings = tm.getSiblings(children[0].id);
      expect(siblings).toHaveLength(2);
      expect(siblings.map((s) => s.title).sort()).toEqual(['B', 'C']);
    });

    it('returns empty for root', () => {
      const { root } = tm.createSession('Problem');
      expect(tm.getSiblings(root.id)).toHaveLength(0);
    });
  });

  // --- Boundary conditions ---

  describe('boundary conditions', () => {
    it('bounds the label of a long problem statement while preserving the prose', () => {
      const longContent = 'x'.repeat(10_000);
      const { root } = tm.createSession(longContent);
      // The label is what a canvas renders, so it stays within the bound; the
      // full statement is retained for surfaces that have room for prose.
      expect(root.title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
      expect(root.statement).toHaveLength(10_000);
    });

    it('handles many children on one node', () => {
      const { root } = tm.createSession('Problem');
      const contents = Array.from({ length: 50 }, (_, i) => ({ title: `Hypothesis ${i}` }));
      const children = tm.decompose(root.id, contents, { axis: 'by cause' });
      expect(children).toHaveLength(50);
      expect(root.children).toHaveLength(50);
    });

    it('handles deep nesting without stack overflow', () => {
      // Use a high maxDepth to test recursion safety, not the limit itself
      const deepTm = new TreeManager({ stagnationThreshold: 4, maxDepth: 200 });
      const { root } = deepTm.createSession('Problem');
      let current = root;
      for (let i = 0; i < 100; i++) {
        const children = deepTm.decompose(current.id, [{ title: `Depth ${i + 1} A` }, { title: `Depth ${i + 1} B` }], { axis: 'by cause' });
        current = children[0];
      }
      expect(current.depth).toBe(100);
    });

    it('rejects decompose when depth limit exceeded', () => {
      const shallowTm = new TreeManager({ maxDepth: 3 });
      const { root } = shallowTm.createSession('Problem');
      const l1 = shallowTm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      const l2 = shallowTm.decompose(l1[0].id, [{ title: 'C' }, { title: 'D' }], { axis: 'by cause' });
      const l3 = shallowTm.decompose(l2[0].id, [{ title: 'E' }, { title: 'F' }], { axis: 'by cause' });
      expect(() => shallowTm.decompose(l3[0].id, [{ title: 'G' }, { title: 'H' }], { axis: 'by cause' })).toThrow('Tree depth limit (3) exceeded');
    });

    it('rejects addHypothesis when depth limit exceeded', () => {
      const shallowTm = new TreeManager({ maxDepth: 2 });
      const { root } = shallowTm.createSession('Problem');
      const l1 = shallowTm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
      const l2 = shallowTm.decompose(l1[0].id, [{ title: 'C' }, { title: 'D' }], { axis: 'by cause' });
      expect(() => shallowTm.addHypothesis(l2[0].id, { title: 'Too deep' })).toThrow('Tree depth limit (2) exceeded');
    });

    it('rejects decompose when hypothesis count limit exceeded', () => {
      const smallTm = new TreeManager({ maxHypotheses: 5 });
      const { root } = smallTm.createSession('Problem');
      smallTm.decompose(root.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { axis: 'by cause' }); // 4 total (root + 3)
      expect(() => smallTm.decompose(root.children[0], [{ title: 'X' }, { title: 'Y' }], { axis: 'by cause' })).toThrow('Maximum hypothesis count (5) exceeded');
    });

    it('rejects addHypothesis when hypothesis count limit exceeded', () => {
      const smallTm = new TreeManager({ maxHypotheses: 4 });
      const { root } = smallTm.createSession('Problem');
      smallTm.decompose(root.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { axis: 'by cause' }); // 4 total
      expect(() => smallTm.addHypothesis(root.id, { title: 'Overflow' })).toThrow('Maximum hypothesis count (4) exceeded');
    });

    it('counts the hypothesis cap per session, not across all sessions', () => {
      // The cap is per tree: a session filled to the limit must not block
      // decompose/add in a different, nearly-empty session of the same manager.
      const smallTm = new TreeManager({ maxHypotheses: 4 });
      const { root: rootA } = smallTm.createSession('Problem A');
      smallTm.decompose(rootA.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { axis: 'by cause' }); // session A: 4 nodes (at cap)

      const { root: rootB } = smallTm.createSession('Problem B');
      // Session B has only its root; decompose must succeed despite A being full.
      expect(() => smallTm.decompose(rootB.id, [{ title: 'X' }, { title: 'Y' }], { axis: 'by cause' })).not.toThrow();
      expect(smallTm.getHypothesesBySession(rootB.sessionId)).toHaveLength(3);
    });
  });

  // --- Active session tracking ---

  describe('getActiveSession', () => {
    it('tracks the most recently driven session, not the most recently created', () => {
      const { session: sessionA, root: rootA } = tm.createSession('Problem A');
      const { session: sessionB } = tm.createSession('Problem B');

      // Most recent creation wins
      expect(tm.getActiveSession()?.id).toBe(sessionB.id);

      // Drive session A
      tm.addEvidence(rootA.id, 'supports', 'Found a clue in A');
      expect(tm.getActiveSession()?.id).toBe(sessionA.id);
    });

    it('skips a resolved session: corroborating the tracked session falls back to the next open one', () => {
      const { session: sessionA, root: rootA } = tm.createSession('Problem A');
      const { session: sessionB } = tm.createSession('Problem B');

      tm.corroborateHypothesis(rootA.id, 'A is the answer');
      expect(sessionA.status).toBe('resolved');

      // getActiveSession returns B (still open), not the just-resolved A
      expect(tm.getActiveSession()?.id).toBe(sessionB.id);
    });

    it('returns undefined when no open session exists', () => {
      const { root } = tm.createSession('Problem');
      tm.corroborateHypothesis(root.id, 'done');
      expect(tm.getActiveSession()).toBeUndefined();
    });

    it('does not promote a session to current when its only progress is elimination', () => {
      // Eliminating a hypothesis is pruning, not investigative progress, so
      // it must not hijack currentSessionId from a session the agent is
      // actively driving.
      const { root: rootA } = tm.createSession('Problem A');
      const { session: sessionB } = tm.createSession('Problem B');
      expect(tm.getActiveSession()?.id).toBe(sessionB.id);

      tm.addEvidence(rootA.id, 'refutes', 'no');
      tm.eliminateHypothesis(rootA.id, 'dead end');
      expect(tm.getActiveSession()?.id).toBe(sessionB.id);
    });

    it('does not flip current session when a mutation resolves its target', () => {
      const { root: rootA } = tm.createSession('Problem A');
      tm.addEvidence(rootA.id, 'supports', 'evidence in A');
      const activeBefore = tm.getActiveSession()?.id;

      const { root: rootB } = tm.createSession('Problem B');
      tm.corroborateHypothesis(rootB.id, 'done');
      // B was just resolved by corroborate; active session stays at A.
      expect(tm.getActiveSession()?.id).toBe(activeBefore);
    });

    it('does not flip current session when a mutation throws', () => {
      const { root: rootA } = tm.createSession('Problem A');
      tm.addEvidence(rootA.id, 'supports', 'evidence in A');
      const activeBefore = tm.getActiveSession()?.id;

      const { root: rootB } = tm.createSession('Problem B');
      tm.corroborateHypothesis(rootB.id, 'done');

      // This mutation is rejected (only refuting evidence is admitted on a
      // corroborated hypothesis). A rejected call must not promote
      // currentSessionId.
      expect(() => tm.addEvidence(rootB.id, 'supports', 'more')).toThrow();
      expect(tm.getActiveSession()?.id).toBe(activeBefore);
    });
  });

  describe('eliminateHypothesis abandons fully-pruned sessions', () => {
    it('marks a session abandoned when every top-level branch is eliminated', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'cause A' }, { title: 'cause B' }], { axis: 'by cause' });

      tm.addEvidence(a.id, 'refutes', 'no');
      tm.eliminateHypothesis(a.id, 'no');
      expect(session.status).toBe('open');

      // Eliminating the last top-level branch leaves no live work and no
      // corroborated answer — the session abandons.
      tm.addEvidence(b.id, 'refutes', 'no');
      tm.eliminateHypothesis(b.id, 'no');
      expect(session.status).toBe('abandoned');
    });

    it('marks a session abandoned when every top-level branch is terminal but none corroborated (mixed eliminated + out-of-scope)', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, [{ title: 'cause A' }, { title: 'cause B' }], { axis: 'by cause' });
      tm.addEvidence(a.id, 'refutes', 'no');
      tm.eliminateHypothesis(a.id, 'no');
      tm.setOutOfScope(b.id, 'set aside');
      // Both top-level branches are terminal (eliminated, out-of-scope) but
      // neither claims survival. The session has no answer to point at.
      expect(session.status).toBe('abandoned');
    });

    it('emits session-completed when a session is abandoned', () => {
      const { root } = tm.createSession('Problem');
      const events: string[] = [];
      tm.on('event', (e) => events.push(e.type));
      tm.addEvidence(root.id, 'refutes', 'no');
      tm.eliminateHypothesis(root.id, 'dead');
      expect(events).toContain('session-completed');
    });

    it('falls through to the next active session after an abandonment', () => {
      const { root: rootA } = tm.createSession('Problem A');
      const { session: sessionB } = tm.createSession('Problem B');
      // Drive A so currentSessionId points at it
      tm.addEvidence(rootA.id, 'supports', 'tested A');
      expect(tm.getActiveSession()?.id).not.toBe(sessionB.id);

      tm.addEvidence(rootA.id, 'refutes', 'no');
      tm.eliminateHypothesis(rootA.id, 'dead end');
      // A is abandoned; getActiveSession picks B.
      expect(tm.getActiveSession()?.id).toBe(sessionB.id);
    });
  });

  describe('loadState', () => {
    it('does not change currentSessionId — only mutations do', () => {
      const { session: a, root: rootA } = tm.createSession('Problem A');
      tm.addEvidence(rootA.id, 'supports', 'evidence');
      expect(tm.getActiveSession()?.id).toBe(a.id);

      // A dashboard view that lazy-loads a historical session must not hijack
      // the agent's active pointer.
      const historical = {
        id: '00000000-0000-4000-8000-000000000001',
        problem: 'Old resolved investigation',
        rootNodeId: '00000000-0000-4000-8000-000000000002',
        status: 'resolved' as const,
        createdAt: new Date(2020, 0, 1).toISOString(),
      };
      tm.loadState([historical], []);

      expect(tm.getActiveSession()?.id).toBe(a.id);
    });
  });
});
