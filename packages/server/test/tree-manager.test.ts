import { describe, it, expect, beforeEach } from 'vitest';
import { TreeManager, TreeError } from '../src/tree-manager.js';
import type { TreeEvent } from '../src/types.js';

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
      expect(session.status).toBe('active');
      expect(root.id).toBe(session.rootNodeId);
      expect(root.parentId).toBeNull();
      expect(root.depth).toBe(0);
      expect(root.status).toBe('pending');
      expect(root.content).toBe('Why is the API slow?');
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
      const children = tm.decompose(root.id, ['Cause A', 'Cause B', 'Cause C']);
      expect(children).toHaveLength(3);
      expect(children[0].parentId).toBe(root.id);
      expect(children[0].depth).toBe(1);
      expect(children[0].content).toBe('Cause A');
      expect(children[0].status).toBe('pending');
      expect(root.children).toHaveLength(3);
    });

    it('rejects fewer than 2 children', () => {
      const { root } = tm.createSession('Problem');
      expect(() => tm.decompose(root.id, ['Only one'])).toThrow(TreeError);
    });

    it('rejects decompose on eliminated hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'Not this');
      tm.eliminateHypothesis(root.id, 'Dead end');
      expect(() => tm.decompose(root.id, ['A', 'B'])).toThrow(TreeError);
    });

    it('rejects decompose on confirmed hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'This is it');
      tm.confirmHypothesis(root.id, 'Confirmed');
      expect(() => tm.decompose(root.id, ['A', 'B'])).toThrow(TreeError);
    });

    it('rejects non-existent parent', () => {
      tm.createSession('Problem');
      expect(() => tm.decompose('fake-id', ['A', 'B'])).toThrow(TreeError);
    });

    it('supports deep nesting', () => {
      const { root } = tm.createSession('Problem');
      const level1 = tm.decompose(root.id, ['L1A', 'L1B']);
      const level2 = tm.decompose(level1[0].id, ['L2A', 'L2B']);
      const level3 = tm.decompose(level2[0].id, ['L3A', 'L3B']);
      expect(level3[0].depth).toBe(3);
    });

    it('emits hypothesis-added for each child', () => {
      const { root } = tm.createSession('Problem');
      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      tm.decompose(root.id, ['A', 'B', 'C']);
      const added = events.filter((e) => e.type === 'hypothesis-added');
      expect(added).toHaveLength(3);
    });
  });

  // --- Add Hypothesis ---

  describe('addHypothesis', () => {
    it('adds a single child hypothesis', () => {
      const { root } = tm.createSession('Problem');
      const h = tm.addHypothesis(root.id, 'New idea');
      expect(h.parentId).toBe(root.id);
      expect(h.content).toBe('New idea');
      expect(h.status).toBe('pending');
      expect(root.children).toContain(h.id);
    });

    it('rejects when parent is eliminated', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'nope');
      tm.eliminateHypothesis(root.id, 'dead');
      expect(() => tm.addHypothesis(root.id, 'Too late')).toThrow(TreeError);
    });

    it('rejects non-existent parent', () => {
      tm.createSession('Problem');
      expect(() => tm.addHypothesis('fake', 'Nope')).toThrow(TreeError);
    });
  });

  // --- Add Evidence ---

  describe('addEvidence', () => {
    it('adds evidence and returns it', () => {
      const { root } = tm.createSession('Problem');
      const ev = tm.addEvidence(root.id, 'supports', 'Log shows error', 'app.log');
      expect(ev.type).toBe('supports');
      expect(ev.content).toBe('Log shows error');
      expect(ev.source).toBe('app.log');
      expect(root.evidence).toHaveLength(1);
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
      tm.confirmHypothesis(root.id, 'Found it');
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

    it('rejects eliminating a confirmed hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'Good');
      tm.confirmHypothesis(root.id, 'Found');
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

  // --- Confirm ---

  describe('confirmHypothesis', () => {
    it('sets status to confirmed with conclusion and completes session', () => {
      const { session, root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'Evidence');
      const result = tm.confirmHypothesis(root.id, 'Root cause found');
      expect(result.status).toBe('confirmed');
      expect(result.conclusion?.verdict).toBe('confirmed');
      expect(session.status).toBe('completed');
    });

    it('rejects confirming an eliminated hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'refutes', 'Bad');
      tm.eliminateHypothesis(root.id, 'Done');
      expect(() => tm.confirmHypothesis(root.id, 'Wait')).toThrow(TreeError);
    });

    it('rejects already confirmed', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'Good');
      tm.confirmHypothesis(root.id, 'Found');
      expect(() => tm.confirmHypothesis(root.id, 'Again')).toThrow(TreeError);
    });

    it('emits hypothesis-updated and session-completed events', () => {
      const { root } = tm.createSession('Problem');
      tm.addEvidence(root.id, 'supports', 'Good');
      const events: TreeEvent[] = [];
      tm.on('event', (e) => events.push(e));
      tm.confirmHypothesis(root.id, 'Found');
      expect(events.some((e) => e.type === 'hypothesis-updated')).toBe(true);
      expect(events.some((e) => e.type === 'session-completed')).toBe(true);
    });
  });

  // --- Score ---

  describe('scoreHypothesis', () => {
    it('sets score on hypothesis', () => {
      const { root } = tm.createSession('Problem');
      tm.scoreHypothesis(root.id, 0.75);
      expect(root.score).toBe(0.75);
    });

    it('rejects score below 0', () => {
      const { root } = tm.createSession('Problem');
      expect(() => tm.scoreHypothesis(root.id, -0.1)).toThrow(TreeError);
    });

    it('rejects score above 1', () => {
      const { root } = tm.createSession('Problem');
      expect(() => tm.scoreHypothesis(root.id, 1.1)).toThrow(TreeError);
    });

    it('rejects NaN score', () => {
      const { root } = tm.createSession('Problem');
      expect(() => tm.scoreHypothesis(root.id, NaN)).toThrow(TreeError);
    });

    it('rejects non-existent hypothesis', () => {
      tm.createSession('Problem');
      expect(() => tm.scoreHypothesis('fake', 0.5)).toThrow(TreeError);
    });
  });

  // --- Validate Decomposition ---

  describe('validateDecomposition', () => {
    it('returns structural checks for children', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, ['Network issue', 'Application bug', 'Data corruption']);
      const check = tm.validateDecomposition(root.id);
      expect(check.childCount).toBe(3);
      expect(check.substringOverlaps).toHaveLength(0);
      expect(check.duplicateLabels).toHaveLength(0);
      expect(check.hasCatchAll).toBe(false);
    });

    it('detects substring overlap', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, ['Network error', 'Network']);
      const check = tm.validateDecomposition(root.id);
      expect(check.substringOverlaps.length).toBeGreaterThan(0);
    });

    it('detects catch-all category', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, ['Known issue', 'Other']);
      const check = tm.validateDecomposition(root.id);
      expect(check.hasCatchAll).toBe(true);
    });

    it('detects duplicate labels', () => {
      const { root } = tm.createSession('Problem');
      tm.decompose(root.id, ['Same thing', 'Same thing', 'Different']);
      const check = tm.validateDecomposition(root.id);
      expect(check.duplicateLabels).toContain('same thing');
    });

    it('rejects non-existent parent', () => {
      tm.createSession('Problem');
      expect(() => tm.validateDecomposition('fake')).toThrow(TreeError);
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
      tm.confirmHypothesis(s1.rootNodeId, 'done');
      tm.createSession('Second');
      const state = tm.getTree(s1.id);
      expect(state!.session.id).toBe(s1.id);
    });
  });

  // --- Get Status ---

  describe('getStatus', () => {
    it('returns counts and progress', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, ['A', 'B', 'C']);
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

    it('reports best lead by score', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, ['A', 'B']);
      tm.scoreHypothesis(children[0].id, 0.3);
      tm.scoreHypothesis(children[1].id, 0.9);
      const status = tm.getStatus();
      expect(status.bestLead?.id).toBe(children[1].id);
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
      const children = tm.decompose(root.id, ['A', 'B']);
      // These are mutations that don't change status (scoring)
      tm.scoreHypothesis(children[0].id, 0.1);
      tm.scoreHypothesis(children[0].id, 0.2);
      tm.scoreHypothesis(children[0].id, 0.3);
      tm.scoreHypothesis(children[0].id, 0.4);
      expect(tm.getStatus().stagnant).toBe(true);
    });

    it('resets after a status change', () => {
      const { root } = tm.createSession('Problem');
      const children = tm.decompose(root.id, ['A', 'B']);
      tm.scoreHypothesis(children[0].id, 0.1);
      tm.scoreHypothesis(children[0].id, 0.2);
      tm.scoreHypothesis(children[0].id, 0.3);
      tm.scoreHypothesis(children[0].id, 0.4);
      expect(tm.getStatus().stagnant).toBe(true);
      // Status change resets
      tm.addEvidence(children[0].id, 'supports', 'Progress');
      expect(tm.getStatus().stagnant).toBe(false);
    });
  });

  // --- Load State ---

  describe('loadState', () => {
    it('restores sessions and hypotheses', () => {
      const { session, root } = tm.createSession('Original');
      const children = tm.decompose(root.id, ['A', 'B']);

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
      const children = tm.decompose(root.id, ['A', 'B', 'C']);
      const siblings = tm.getSiblings(children[0].id);
      expect(siblings).toHaveLength(2);
      expect(siblings.map((s) => s.content).sort()).toEqual(['B', 'C']);
    });

    it('returns empty for root', () => {
      const { root } = tm.createSession('Problem');
      expect(tm.getSiblings(root.id)).toHaveLength(0);
    });
  });

  // --- Boundary conditions ---

  describe('boundary conditions', () => {
    it('handles long content strings', () => {
      const longContent = 'x'.repeat(10_000);
      const { root } = tm.createSession(longContent);
      expect(root.content).toHaveLength(10_000);
    });

    it('handles many children on one node', () => {
      const { root } = tm.createSession('Problem');
      const contents = Array.from({ length: 50 }, (_, i) => `Hypothesis ${i}`);
      const children = tm.decompose(root.id, contents);
      expect(children).toHaveLength(50);
      expect(root.children).toHaveLength(50);
    });

    it('handles deep nesting without stack overflow', () => {
      // Use a high maxDepth to test recursion safety, not the limit itself
      const deepTm = new TreeManager({ stagnationThreshold: 4, maxDepth: 200 });
      const { root } = deepTm.createSession('Problem');
      let current = root;
      for (let i = 0; i < 100; i++) {
        const children = deepTm.decompose(current.id, [`Depth ${i + 1} A`, `Depth ${i + 1} B`]);
        current = children[0];
      }
      expect(current.depth).toBe(100);
    });

    it('rejects decompose when depth limit exceeded', () => {
      const shallowTm = new TreeManager({ maxDepth: 3 });
      const { root } = shallowTm.createSession('Problem');
      const l1 = shallowTm.decompose(root.id, ['A', 'B']);
      const l2 = shallowTm.decompose(l1[0].id, ['C', 'D']);
      const l3 = shallowTm.decompose(l2[0].id, ['E', 'F']);
      expect(() => shallowTm.decompose(l3[0].id, ['G', 'H'])).toThrow('Tree depth limit (3) exceeded');
    });

    it('rejects addHypothesis when depth limit exceeded', () => {
      const shallowTm = new TreeManager({ maxDepth: 2 });
      const { root } = shallowTm.createSession('Problem');
      const l1 = shallowTm.decompose(root.id, ['A', 'B']);
      const l2 = shallowTm.decompose(l1[0].id, ['C', 'D']);
      expect(() => shallowTm.addHypothesis(l2[0].id, 'Too deep')).toThrow('Tree depth limit (2) exceeded');
    });

    it('rejects decompose when hypothesis count limit exceeded', () => {
      const smallTm = new TreeManager({ maxHypotheses: 5 });
      const { root } = smallTm.createSession('Problem');
      smallTm.decompose(root.id, ['A', 'B', 'C']); // 4 total (root + 3)
      expect(() => smallTm.decompose(root.children[0], ['X', 'Y'])).toThrow('Maximum hypothesis count (5) exceeded');
    });

    it('rejects addHypothesis when hypothesis count limit exceeded', () => {
      const smallTm = new TreeManager({ maxHypotheses: 4 });
      const { root } = smallTm.createSession('Problem');
      smallTm.decompose(root.id, ['A', 'B', 'C']); // 4 total
      expect(() => smallTm.addHypothesis(root.id, 'Overflow')).toThrow('Maximum hypothesis count (4) exceeded');
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

    it('skips a completed session: confirming the tracked session falls back to the next active one', () => {
      const { session: sessionA, root: rootA } = tm.createSession('Problem A');
      const { session: sessionB } = tm.createSession('Problem B');

      tm.confirmHypothesis(rootA.id, 'A is the answer');
      expect(sessionA.status).toBe('completed');

      // getActiveSession returns B (still active), not the just-completed A
      expect(tm.getActiveSession()?.id).toBe(sessionB.id);
    });

    it('returns undefined when no active session exists', () => {
      const { root } = tm.createSession('Problem');
      tm.confirmHypothesis(root.id, 'done');
      expect(tm.getActiveSession()).toBeUndefined();
    });

    it('does not promote a session to current when its only progress is elimination', () => {
      // Eliminating a hypothesis is pruning, not investigative progress, so
      // it must not hijack currentSessionId from a session the agent is
      // actively driving.
      const { root: rootA } = tm.createSession('Problem A');
      const { session: sessionB } = tm.createSession('Problem B');
      expect(tm.getActiveSession()?.id).toBe(sessionB.id);

      tm.eliminateHypothesis(rootA.id, 'dead end');
      expect(tm.getActiveSession()?.id).toBe(sessionB.id);
    });

    it('does not flip current session when a mutation completes its target', () => {
      const { root: rootA } = tm.createSession('Problem A');
      tm.addEvidence(rootA.id, 'supports', 'evidence in A');
      const activeBefore = tm.getActiveSession()?.id;

      const { root: rootB } = tm.createSession('Problem B');
      tm.confirmHypothesis(rootB.id, 'done');
      // B was just completed by confirm; active session stays at A.
      expect(tm.getActiveSession()?.id).toBe(activeBefore);
    });

    it('does not flip current session when a mutation throws', () => {
      const { root: rootA } = tm.createSession('Problem A');
      tm.addEvidence(rootA.id, 'supports', 'evidence in A');
      const activeBefore = tm.getActiveSession()?.id;

      const { root: rootB } = tm.createSession('Problem B');
      tm.confirmHypothesis(rootB.id, 'done');

      // Score validation fails before any state change. currentSessionId
      // must not be promoted on a rejected call.
      expect(() => tm.scoreHypothesis(rootB.id, NaN)).toThrow();
      expect(tm.getActiveSession()?.id).toBe(activeBefore);
    });
  });

  describe('eliminateHypothesis abandons fully-pruned sessions', () => {
    it('marks a session abandoned when every hypothesis is eliminated', () => {
      const { session, root } = tm.createSession('Problem');
      const [a, b] = tm.decompose(root.id, ['cause A', 'cause B']);

      tm.eliminateHypothesis(a.id, 'no');
      tm.eliminateHypothesis(b.id, 'no');
      expect(session.status).toBe('active');

      // Eliminating the root is the last live hypothesis — session abandons.
      tm.eliminateHypothesis(root.id, 'all branches dead');
      expect(session.status).toBe('abandoned');
    });

    it('emits session-completed when a session is abandoned', () => {
      const { root } = tm.createSession('Problem');
      const events: string[] = [];
      tm.on('event', (e) => events.push(e.type));
      tm.eliminateHypothesis(root.id, 'dead');
      expect(events).toContain('session-completed');
    });

    it('falls through to the next active session after an abandonment', () => {
      const { root: rootA } = tm.createSession('Problem A');
      const { session: sessionB } = tm.createSession('Problem B');
      // Drive A so currentSessionId points at it
      tm.addEvidence(rootA.id, 'supports', 'tested A');
      expect(tm.getActiveSession()?.id).not.toBe(sessionB.id);

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
        problem: 'Old completed investigation',
        rootNodeId: '00000000-0000-4000-8000-000000000002',
        status: 'completed' as const,
        createdAt: new Date(2020, 0, 1).toISOString(),
      };
      tm.loadState([historical], []);

      expect(tm.getActiveSession()?.id).toBe(a.id);
    });
  });
});
