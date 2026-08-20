import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TreeManager } from '../src/tree-manager.js';
import { registerTools } from '../src/tools.js';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function parseResult(result: any): any {
  const text = result.content?.find((c: any) => c.type === 'text')?.text;
  if (!text) return null;
  const firstLine = text.split('\n')[0];
  try {
    return JSON.parse(firstLine);
  } catch {
    return { raw: text };
  }
}

function getText(result: any): string {
  return result.content?.find((c: any) => c.type === 'text')?.text ?? '';
}

describe('MCP Integration', () => {
  let client: Client;
  let server: McpServer;
  let tm: TreeManager;

  beforeEach(async () => {
    tm = new TreeManager({ stagnationThreshold: 4 });
    server = new McpServer({ name: 'tot-mcp-test', version: '0.1.0' });
    registerTools(server, tm, () => '/tmp/tot-test');

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
  });

  // ─── Tool Discovery ───

  describe('tool discovery', () => {
    it('lists all 11 tools with correct names', async () => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(11);
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'add_evidence', 'add_hypothesis', 'corroborate_hypothesis',
        'create_tree', 'decompose', 'eliminate_hypothesis',
        'get_status', 'get_tree',
        'qualify_evidence', 'set_out_of_scope', 'validate_decomposition',
      ]);
    });

    it('each tool has a description and inputSchema', async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  // ─── create_tree ───

  describe('create_tree', () => {
    it('returns session and root IDs', async () => {
      const result = await client.callTool({
        name: 'create_tree',
        arguments: { problem: 'API returns 500 errors' },
      });
      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.sessionId).toBeDefined();
      expect(data.rootId).toBeDefined();
    });

    it('response includes methodology guidance', async () => {
      const result = await client.callTool({
        name: 'create_tree',
        arguments: { problem: 'Memory leak in production' },
      });
      const text = getText(result);
      expect(text).toContain('Decomposition');
      expect(text).toContain('REFUTE');
    });

    it('error: empty problem string', async () => {
      const result = await client.callTool({
        name: 'create_tree',
        arguments: { problem: '' },
      });
      expect(result.isError).toBe(true);
    });
  });

  // ─── decompose ───

  describe('decompose', () => {
    it('creates children and returns IDs', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { axis: 'by cause', problem: 'Test' } }),
      );
      const result = await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['Network', 'Application', 'Data', 'Infrastructure'] },
      });
      expect(result.isError).toBeFalsy();
      const { childIds } = parseResult(result);
      expect(childIds).toHaveLength(4);
    });

    it('response includes structural guidance', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const result = await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['Network layer', 'Application layer'] },
      });
      const text = getText(result);
      expect(text).toContain('Decomposition Review');
    });

    it('supports multi-level decomposition', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Root' } }),
      );
      const { childIds: level1 } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
        }),
      );
      const { childIds: level2 } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: level1[0], children: ['A.1', 'A.2', 'A.3'] },
        }),
      );
      expect(level2).toHaveLength(3);

      // Verify tree shows all levels
      const tree = await client.callTool({ name: 'get_tree', arguments: { format: 'compact' } });
      const text = getText(tree);
      expect(text).toContain('A.1');
      expect(text).toContain('B');
    });

    it('error: fewer than 2 children', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const result = await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['Only one'] },
      });
      expect(result.isError).toBe(true);
    });

    it('error: non-existent parent', async () => {
      await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } });
      const result = await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: 'nonexistent', children: ['A', 'B'] },
      });
      expect(result.isError).toBe(true);
    });

    it('error: decompose eliminated node', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'refutes', content: 'nope' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'dead' },
      });
      const result = await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
      });
      expect(result.isError).toBe(true);
    });
  });

  // ─── add_hypothesis ───

  describe('add_hypothesis', () => {
    it('adds a single child and returns ID', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
      });
      const result = await client.callTool({
        name: 'add_hypothesis',
        arguments: { parentId: rootId, title: 'C — missed this one' },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).hypothesisId).toBeDefined();
    });

    it('error: add to eliminated parent', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'refutes', content: 'nope' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'done' },
      });
      const result = await client.callTool({
        name: 'add_hypothesis',
        arguments: { parentId: rootId, title: 'Too late' },
      });
      expect(result.isError).toBe(true);
    });
  });

  // ─── label authoring ───

  describe('title authoring', () => {
    async function root() {
      return parseResult(await client.callTool({
        name: 'create_tree', arguments: { problem: 'Why is the widget slow' },
      })).rootId;
    }

    it('accepts a title at the length bound and rejects one over it', async () => {
      const parentId = await root();
      const ok = await client.callTool({
        name: 'add_hypothesis', arguments: { parentId, title: 'x'.repeat(80) },
      });
      expect(ok.isError).toBeFalsy();
      const tooLong = await client.callTool({
        name: 'add_hypothesis', arguments: { parentId, title: 'x'.repeat(81) },
      });
      expect(tooLong.isError).toBe(true);
    });

    it('rejects a title that reads as a sentence rather than a label', async () => {
      const parentId = await root();
      const result = await client.callTool({
        name: 'add_hypothesis', arguments: { parentId, title: 'The pool exhausts.' },
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toMatch(/period|label/i);
    });

    it('rejects a blank title', async () => {
      const parentId = await root();
      const result = await client.callTool({
        name: 'add_hypothesis', arguments: { parentId, title: '   ' },
      });
      expect(result.isError).toBe(true);
    });

    it('stores an optional statement alongside the title', async () => {
      const parentId = await root();
      const added = await client.callTool({
        name: 'add_hypothesis',
        arguments: { parentId, title: 'Writer pool exhaustion', statement: 'The pool exhausts under retry storms.' },
      });
      expect(added.isError).toBeFalsy();
      const full = JSON.parse(getText(await client.callTool({ name: 'get_tree', arguments: { format: 'full' } })));
      const node = Object.values(full.hypotheses as Record<string, any>)
        .find((h: any) => h.title === 'Writer pool exhaustion') as any;
      expect(node.statement).toBe('The pool exhausts under retry storms.');
    });

    it('decompose accepts bare-string titles and the object form together', async () => {
      const parentId = await root();
      const result = await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause',
          parentId,
          children: ['Network latency', { title: 'CPU contention', statement: 'The host is saturated.' }],
        },
      });
      expect(result.isError).toBeFalsy();
      const full = JSON.parse(getText(await client.callTool({ name: 'get_tree', arguments: { format: 'full' } })));
      const byTitle = Object.fromEntries(
        Object.values(full.hypotheses as Record<string, any>).map((h: any) => [h.title, h]),
      );
      expect(byTitle['Network latency']).toBeDefined();
      expect(byTitle['CPU contention'].statement).toBe('The host is saturated.');
    });

    it('decompose rejects an over-long child title', async () => {
      const parentId = await root();
      const result = await client.callTool({
        name: 'decompose', arguments: { axis: 'by cause', parentId, children: ['ok', 'x'.repeat(81)] },
      });
      expect(result.isError).toBe(true);
    });

    it('create_tree accepts a root title without altering the problem statement', async () => {
      const created = await client.callTool({
        name: 'create_tree',
        arguments: { problem: 'Why is the widget slow under sustained retry load', rootTitle: 'Widget slowness' },
      });
      expect(created.isError).toBeFalsy();
      const full = JSON.parse(getText(await client.callTool({ name: 'get_tree', arguments: { format: 'full' } })));
      expect(full.session.problem).toBe('Why is the widget slow under sustained retry load');
      expect(full.hypotheses[full.session.rootNodeId].title).toBe('Widget slowness');
    });

    it('advertises the title length bound in the discovered schema', async () => {
      // The bound is the whole mechanism by which an agent learns to author a
      // label; a constraint the client cannot see is a constraint it will breach.
      const { tools } = await client.listTools();
      const addHypothesis = tools.find((t) => t.name === 'add_hypothesis')!;
      const title = (addHypothesis.inputSchema as any).properties.title;
      expect(title.maxLength).toBe(80);
    });
  });

  // ─── add_evidence ───

  describe('add_evidence', () => {
    it('records evidence with all fields', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const result = await client.callTool({
        name: 'add_evidence',
        arguments: {
          hypothesisId: rootId,
          type: 'supports',
          content: 'Stack trace shows NPE at line 42',
          source: 'Application logs',
        },
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('+1');
    });

    it('records all three evidence types', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: rootId, children: ['H1', 'H2', 'H3'] },
        }),
      );

      for (const [id, type] of [[childIds[0], 'supports'], [childIds[1], 'refutes'], [childIds[2], 'neutral']] as const) {
        const result = await client.callTool({
          name: 'add_evidence',
          arguments: { hypothesisId: id, type, content: `Evidence ${type}` },
        });
        expect(result.isError).toBeFalsy();
      }
    });

    it('shows sibling overview in response', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: rootId, children: ['Alpha', 'Beta'] },
        }),
      );
      const result = await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: childIds[0], type: 'supports', content: 'data' },
      });
      const text = getText(result);
      expect(text).toContain('Beta');
    });

    it('error: evidence on eliminated hypothesis', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'refutes', content: 'bad' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'done' },
      });
      const result = await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'supports', content: 'too late' },
      });
      expect(result.isError).toBe(true);
    });

    it('error: non-existent hypothesis', async () => {
      await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } });
      const result = await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: 'fake-id-123', type: 'supports', content: 'data' },
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('fake-id-123');
    });
  });

  // ─── eliminate_hypothesis ───

  describe('eliminate_hypothesis', () => {
    it('eliminates and shows remaining siblings', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: rootId, children: ['Will die', 'Will survive', 'Also survives'] },
        }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'bad' },
      });
      const result = await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: childIds[0], reason: 'Evidence refutes it' },
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Remaining: 2');
    });

    it('error: already eliminated', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'refutes', content: 'bad' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'first' },
      });
      const result = await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'second' },
      });
      expect(result.isError).toBe(true);
    });

    it('error: eliminate confirmed hypothesis', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'supports', content: 'good' },
      });
      await client.callTool({
        name: 'corroborate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'confirmed' },
      });
      const result = await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'wait no' },
      });
      expect(result.isError).toBe(true);
    });
  });

  // ─── corroborate_hypothesis ───

  describe('corroborate_hypothesis', () => {
    it('corroborates and includes completeness prompt', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'supports', content: 'proof' },
      });
      const result = await client.callTool({
        name: 'corroborate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'Root cause found' },
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Corroborated');
      expect(text).toContain('account for ALL the relevant observations');
    });

    it('error: corroborate eliminated hypothesis', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'refutes', content: 'bad' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'dead' },
      });
      const result = await client.callTool({
        name: 'corroborate_hypothesis',
        arguments: { hypothesisId: rootId, reason: 'actually yes' },
      });
      expect(result.isError).toBe(true);
    });
  });

  // ─── scoring removed: no score_hypothesis tool ───

  describe('no scoring tool', () => {
    it('score_hypothesis is not a registered tool', async () => {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain('score_hypothesis');
    });

    it('tool responses and tree JSON expose no score field', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const dec = await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
      });
      expect(getText(dec)).not.toMatch(/score/i);
      const tree = await client.callTool({ name: 'get_tree', arguments: { format: 'full' } });
      const parsed = JSON.parse(getText(tree));
      for (const h of Object.values(parsed.hypotheses) as any[]) {
        expect(h).not.toHaveProperty('score');
        expect(h).not.toHaveProperty('scoreRationale');
      }
    });
  });

  // ─── get_tree ───

  describe('get_tree', () => {
    it('compact format shows tree structure with status icons', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Debug issue' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: rootId, children: ['Network', 'App code'] },
        }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'nope' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: childIds[0], reason: 'Metrics normal' },
      });

      const result = await client.callTool({
        name: 'get_tree',
        arguments: { format: 'compact' },
      });
      const text = getText(result);
      expect(text).toContain('✗'); // eliminated
      expect(text).toContain('○'); // pending
      expect(text).toContain('Network');
      expect(text).toContain('App code');
    });

    it('full format returns valid JSON with all data', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['X', 'Y'] },
      });
      const result = await client.callTool({
        name: 'get_tree',
        arguments: { format: 'full' },
      });
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed.session).toBeDefined();
      expect(parsed.hypotheses).toBeDefined();
      expect(Object.keys(parsed.hypotheses).length).toBe(3); // root + X + Y
    });

    it('returns message when no session exists', async () => {
      const result = await client.callTool({
        name: 'get_tree',
        arguments: { format: 'compact' },
      });
      expect(getText(result)).toContain('No open session');
    });

    it('rejects an unsupported format value at the wire boundary', async () => {
      await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } });
      // The format enum is enforced by the registered tool schema, so the SDK
      // rejects an out-of-enum value before the handler runs and names the
      // valid options.
      const result = await client.callTool({
        name: 'get_tree',
        arguments: { format: 'path' },
      });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain('full');
      expect(text).toContain('compact');
    });

    it('renders a specific session when sessionId is passed', async () => {
      // Two sessions open in one project; get_tree(sessionId) must render the
      // named one, not just the active (most-recent) session.
      const a = parseResult(await client.callTool({ name: 'create_tree', arguments: { problem: 'Session A problem' } }));
      await client.callTool({ name: 'create_tree', arguments: { problem: 'Session B problem' } });

      // Active session is B (most recently created); fetch A explicitly.
      const result = await client.callTool({
        name: 'get_tree',
        arguments: { format: 'compact', sessionId: a.sessionId },
      });
      const text = getText(result);
      expect(text).toContain('Session A problem');
      expect(text).not.toContain('Session B problem');
    });

    it('rejects get_tree for an unknown sessionId', async () => {
      await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } });
      const result = await client.callTool({
        name: 'get_tree',
        arguments: { format: 'compact', sessionId: 'no-such-session' },
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('No such session');
    });
  });

  // ─── get_status ───

  describe('get_status', () => {
    it('returns progress and unexplored', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Issue' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: rootId, children: ['H1', 'H2', 'H3'] },
        }),
      );
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'no' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: childIds[0], reason: 'done' },
      });

      const result = await client.callTool({ name: 'get_status', arguments: {} });
      const text = getText(result);
      expect(text).toContain('Issue');
      expect(text).toContain('eliminated');
      expect(text).toContain('H2');
      expect(text).toContain('H3');
    });

    it('omits any Visualization URL when no dashboard-url thunk is provided', async () => {
      // The default wiring (used by these integration tests) passes no URL
      // thunk; get_status must not advertise a dashboard URL it cannot resolve.
      await client.callTool({ name: 'create_tree', arguments: { problem: 'NoUrl' } });
      const text = getText(await client.callTool({ name: 'get_status', arguments: {} }));
      expect(text).not.toContain('Visualization');
      expect(text).not.toContain('http://');
    });

    it('appends the dashboard URL when a getDashboardUrl thunk is provided', async () => {
      // A per-session server knows its own ephemeral port and surfaces it here.
      const tm2 = new TreeManager({ stagnationThreshold: 4 });
      const server2 = new McpServer({ name: 'tot-mcp-test-url', version: '0.1.0' });
      registerTools(server2, tm2, () => '/tmp/tot-test', { getDashboardUrl: () => 'http://localhost:12345' });
      const client2 = new Client({ name: 'c2', version: '1.0.0' }, { capabilities: {} });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([client2.connect(ct), server2.connect(st)]);
      try {
        await client2.callTool({ name: 'create_tree', arguments: { problem: 'WithUrl' } });
        const text = getText(await client2.callTool({ name: 'get_status', arguments: {} }));
        expect(text).toContain('Visualization: http://localhost:12345');
      } finally {
        await client2.close();
      }
    });

    it('still surfaces the dashboard URL once every branch is terminal (dashboard renders any session)', async () => {
      // The dashboard server renders the project's most-recent session whether
      // or not an investigation is still active, so the URL must remain
      // discoverable after a tree reaches a terminal state.
      const tm2 = new TreeManager({ stagnationThreshold: 4 });
      const server2 = new McpServer({ name: 'tot-mcp-test-resolved', version: '0.1.0' });
      registerTools(server2, tm2, () => '/tmp/tot-test', { getDashboardUrl: () => 'http://localhost:23456' });
      const client2 = new Client({ name: 'c-resolved', version: '1.0.0' }, { capabilities: {} });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([client2.connect(ct), server2.connect(st)]);
      try {
        const { rootId } = parseResult(
          await client2.callTool({ name: 'create_tree', arguments: { problem: 'Resolves' } }),
        );
        const { childIds } = parseResult(
          await client2.callTool({ name: 'decompose', arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] } }),
        );
        // Drive the session to a terminal state: A eliminated, B corroborated.
        await client2.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'no' } });
        await client2.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'gone' } });
        await client2.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[1], type: 'supports', content: 'yes' } });
        await client2.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: childIds[1], reason: 'survives' } });

        const text = getText(await client2.callTool({ name: 'get_status', arguments: {} }));
        // No open session remains, but the dashboard URL is still discoverable.
        expect(text).toContain('Visualization: http://localhost:23456');
      } finally {
        await client2.close();
      }
    });

    it('does not advertise active work for a terminal session with pending descendants under a pruned branch', async () => {
      // Pruning does not cascade, so a resolved session can retain pending
      // descendants under an eliminated/out-of-scope ancestor. The status
      // read-out for a terminal session must not present those moot nodes as
      // live work (no Active/Unexplored clauses), which would misrepresent a
      // completed investigation as still in progress.
      const tm2 = new TreeManager({ stagnationThreshold: 4 });
      const server2 = new McpServer({ name: 'tot-mcp-test-terminal', version: '0.1.0' });
      registerTools(server2, tm2, () => '/tmp/tot-test');
      const client2 = new Client({ name: 'c-terminal', version: '1.0.0' }, { capabilities: {} });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([client2.connect(ct), server2.connect(st)]);
      try {
        const { rootId } = parseResult(
          await client2.callTool({ name: 'create_tree', arguments: { problem: 'Leaked pending' } }),
        );
        const { childIds } = parseResult(
          await client2.callTool({ name: 'decompose', arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] } }),
        );
        // Give A its own pending children, then prune A without resolving them.
        await client2.callTool({ name: 'decompose', arguments: { axis: 'by cause', parentId: childIds[0], children: ['A1', 'A2'] } });
        await client2.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'no' } });
        await client2.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'gone' } });
        // Corroborate B → session resolves while A1/A2 remain pending under pruned A.
        await client2.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[1], type: 'supports', content: 'yes' } });
        await client2.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: childIds[1], reason: 'survives' } });

        const text = getText(await client2.callTool({ name: 'get_status', arguments: {} }));
        expect(text).toContain('(resolved)');
        // A completed investigation must not report live work.
        expect(text).not.toContain('Active:');
        expect(text).not.toContain('Unexplored:');
        expect(text).not.toContain('STAGNATION');
      } finally {
        await client2.close();
      }
    });

    it('separates resolved and active counts in the progress breakdown', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Topic' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B', 'C'] },
        }),
      );
      await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'no' } });
      await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'gone' } });
      await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[1], type: 'supports', content: 'yes' } });
      // childIds[1] is now 'exploring'; childIds[2] stays 'pending'.

      const result = await client.callTool({ name: 'get_status', arguments: {} });
      const text = getText(result);
      // Resolved parenthetical lists only resolved sub-counts.
      expect(text).toMatch(/Progress: 1\/4 resolved \(1 eliminated, 0 corroborated\)/);
      // Active line lists exploring and pending separately (root is exploring,
      // childIds[1] is exploring after evidence, childIds[2] stays pending).
      expect(text).toContain('Active: 2 exploring, 1 pending');
    });

    it('detects stagnation', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] },
        }),
      );
      // First evidence flips the child pending→exploring (resets the
      // counter); subsequent same-status mutations accumulate. 5 neutral
      // additions leave 4 mutations without a status change = stagnation.
      for (let i = 0; i < 5; i++) {
        await client.callTool({
          name: 'add_evidence',
          arguments: { hypothesisId: childIds[0], type: 'neutral', content: `note ${i}` },
        });
      }

      const result = await client.callTool({ name: 'get_status', arguments: {} });
      const text = getText(result);
      expect(text).toContain('STAGNATION');
    });

    it('no session returns informative message', async () => {
      const result = await client.callTool({ name: 'get_status', arguments: {} });
      expect(getText(result)).toContain('No open session');
    });
  });

  // ─── validate_decomposition ───

  describe('validate_decomposition', () => {
    it('detects substring overlap', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['Network error', 'Network'] },
      });
      const result = await client.callTool({
        name: 'validate_decomposition',
        arguments: { parentId: rootId },
      });
      const text = getText(result);
      expect(text).toContain('overlap');
    });

    it('detects catch-all category', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['Specific cause', 'Other'] },
      });
      const result = await client.callTool({
        name: 'validate_decomposition',
        arguments: { parentId: rootId },
      });
      const text = getText(result);
      expect(text).toContain('catch-all');
    });

    it('passes for clean decomposition', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['Network layer', 'Application layer', 'Data layer'] },
      });
      const result = await client.callTool({
        name: 'validate_decomposition',
        arguments: { parentId: rootId },
      });
      const text = getText(result);
      expect(text).toContain('No substring overlaps');
    });

    it('emits advisory categories rather than pass/fail', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['Network error', 'Network'] },
      });
      const result = await client.callTool({
        name: 'validate_decomposition',
        arguments: { parentId: rootId },
      });
      const text = getText(result);
      // Output uses advisory vocabulary, not PASS/FAIL/NEEDS_REVISION
      expect(text).not.toContain('PASS');
      expect(text).not.toContain('FAIL');
      expect(text).toContain('overlap-advisory');
    });

    it('detects abstraction mismatch and emits level-mismatch-advisory', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: [
          'Layer issue',
          'Persistent connection drift in long-lived socket pool under reuse pressure',
        ] },
      });
      const result = await client.callTool({
        name: 'validate_decomposition',
        arguments: { parentId: rootId },
      });
      const text = getText(result);
      expect(text).toContain('level-mismatch-advisory');
    });

    it('error: non-existent parent', async () => {
      await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } });
      const result = await client.callTool({
        name: 'validate_decomposition',
        arguments: { parentId: 'fake' },
      });
      expect(result.isError).toBe(true);
    });
  });

  // ─── Complex Workflows (simulating real agent behavior) ───

  describe('complex workflows', () => {
    it('full 3-level debugging session with branching and elimination', async () => {
      // Level 0: Create
      const { rootId } = parseResult(
        await client.callTool({
          name: 'create_tree',
          arguments: { problem: 'API returns 500 for 5% of requests since v2.4.1' },
        }),
      );

      // Level 1: First decomposition
      const { childIds: l1 } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause',
            parentId: rootId,
            children: ['Application code error', 'Dependency failure', 'Infrastructure issue', 'Load pattern issue'],
          },
        }),
      );

      // Gather evidence and eliminate L1 branches
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: l1[1], type: 'refutes', content: 'All dependency dashboards green' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: l1[1], reason: 'Dependencies healthy' },
      });

      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: l1[2], type: 'refutes', content: 'Infra metrics normal' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: l1[2], reason: 'Infrastructure normal' },
      });

      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: l1[3], type: 'refutes', content: 'Error rate constant regardless of load' },
      });
      await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: l1[3], reason: 'Not load-dependent' },
      });

      // Evidence supporting L1[0]
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: l1[0], type: 'supports', content: 'Stack trace shows NullPointerException' },
      });

      // Level 2: Decompose the winning branch
      const { childIds: l2 } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause',
            parentId: l1[0],
            children: ['Null pointer on data patterns', 'Race condition', 'Schema mismatch', 'Bug in v2.4.1 code'],
          },
        }),
      );

      // Level 3: Evidence narrows it down
      await client.callTool({
        name: 'add_evidence',
        arguments: {
          hypothesisId: l2[0],
          type: 'supports',
          content: 'Failing requests ALL have gift_message=null, ~5% of orders',
          source: 'DB query correlation',
        },
      });

      // Corroborate root cause
      const corroborateResult = await client.callTool({
        name: 'corroborate_hypothesis',
        arguments: {
          hypothesisId: l2[0],
          reason: 'v2.4.1 line 142: order.getGiftMessage().length() without null check. 5% of orders have null gift_message.',
        },
      });
      expect(corroborateResult.isError).toBeFalsy();
      expect(getText(corroborateResult)).toContain('Corroborated');
    });

    it('agent adds missed hypothesis after initial decompose', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Build failing' } }),
      );
      await client.callTool({
        name: 'decompose',
        arguments: { axis: 'by cause', parentId: rootId, children: ['Dep conflict', 'Syntax error'] },
      });

      // Agent realizes it missed something
      const addResult = await client.callTool({
        name: 'add_hypothesis',
        arguments: { parentId: rootId, title: 'Flaky test infrastructure' },
      });
      expect(addResult.isError).toBeFalsy();

      // Tree now has 3 children under root
      const tree = await client.callTool({ name: 'get_tree', arguments: { format: 'compact' } });
      const text = getText(tree);
      expect(text).toContain('Dep conflict');
      expect(text).toContain('Syntax error');
      expect(text).toContain('Flaky test infrastructure');
    });

    it('response format includes tree summary on every tool call', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B', 'C'] },
        }),
      );

      // Every mutating tool should include tree summary
      const evResult = await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: childIds[0], type: 'supports', content: 'data' },
      });
      expect(getText(evResult)).toContain('Progress:');

      const addResult = await client.callTool({
        name: 'add_hypothesis',
        arguments: { parentId: rootId, title: 'D' },
      });
      expect(getText(addResult)).toContain('Progress:');

      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: childIds[2], type: 'refutes', content: 'nope' },
      });
      const elimResult = await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: childIds[2], reason: 'nope' },
      });
      expect(getText(elimResult)).toContain('Progress:');
    });
  });
});

// ─── Persistence failure surfacing ───

describe('MCP Integration — persistence failure surfacing', () => {
  let client: Client;
  let server: McpServer;
  let tm: TreeManager;
  let roDir: string;

  beforeEach(async () => {
    // The sessions dir exists but is read-only, so the Persistence constructor's
    // recursive mkdir of an existing dir succeeds while appendFile (the journal
    // write) fails with EACCES — the exact split where the in-memory mutation
    // succeeds but the durable write does not, which must NOT be acknowledged as
    // success.
    roDir = mkdtempSync(join(tmpdir(), 'tot-ro-'));
    const sessionsDir = join(roDir, 'sessions');
    mkdirSync(sessionsDir);
    chmodSync(sessionsDir, 0o500);

    tm = new TreeManager({ stagnationThreshold: 4 });
    server = new McpServer({ name: 'tot-mcp-test', version: '0.1.0' });
    registerTools(server, tm, () => sessionsDir);

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    try { chmodSync(roDir, 0o700); rmSync(roDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a mutating tool returns isError when its journal write fails (no silent data loss)', async () => {
    const result = await client.callTool({
      name: 'create_tree',
      arguments: { problem: 'this will fail to persist' },
    });
    // The mutation cannot be durably recorded, so the agent must be told it
    // failed rather than receiving a success for state that never hit disk.
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/persist|save|disk|write/i);
  });
});
