import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TreeManager } from '../src/tree-manager.js';
import { registerTools } from '../src/tools.js';

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
    it('lists all 10 tools with correct names', async () => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(10);
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'add_evidence', 'add_hypothesis', 'corroborate_hypothesis',
        'create_tree', 'decompose', 'eliminate_hypothesis',
        'get_status', 'get_tree', 'score_hypothesis', 'validate_decomposition',
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
      expect(text).toContain('MECE');
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
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const result = await client.callTool({
        name: 'decompose',
        arguments: { parentId: rootId, children: ['Network', 'Application', 'Data', 'Infrastructure'] },
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
        arguments: { parentId: rootId, children: ['Network layer', 'Application layer'] },
      });
      const text = getText(result);
      expect(text).toContain('MECE Review');
    });

    it('supports multi-level decomposition', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Root' } }),
      );
      const { childIds: level1 } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { parentId: rootId, children: ['A', 'B'] },
        }),
      );
      const { childIds: level2 } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { parentId: level1[0], children: ['A.1', 'A.2', 'A.3'] },
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
        arguments: { parentId: rootId, children: ['Only one'] },
      });
      expect(result.isError).toBe(true);
    });

    it('error: non-existent parent', async () => {
      await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } });
      const result = await client.callTool({
        name: 'decompose',
        arguments: { parentId: 'nonexistent', children: ['A', 'B'] },
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
        arguments: { parentId: rootId, children: ['A', 'B'] },
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
        arguments: { parentId: rootId, children: ['A', 'B'] },
      });
      const result = await client.callTool({
        name: 'add_hypothesis',
        arguments: { parentId: rootId, content: 'C — missed this one' },
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
        arguments: { parentId: rootId, content: 'Too late' },
      });
      expect(result.isError).toBe(true);
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
          arguments: { parentId: rootId, children: ['H1', 'H2', 'H3'] },
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
          arguments: { parentId: rootId, children: ['Alpha', 'Beta'] },
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
          arguments: { parentId: rootId, children: ['Will die', 'Will survive', 'Also survives'] },
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
      expect(text).toContain('explain ALL observed symptoms');
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

  // ─── score_hypothesis ───

  describe('score_hypothesis', () => {
    it('sets score and shows ranking', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { parentId: rootId, children: ['Low', 'High'] },
        }),
      );
      await client.callTool({
        name: 'score_hypothesis',
        arguments: { hypothesisId: childIds[0], score: 0.2 },
      });
      const result = await client.callTool({
        name: 'score_hypothesis',
        arguments: { hypothesisId: childIds[1], score: 0.9, rationale: 'Strong evidence' },
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('0.90');
    });

    it('error: score above 1', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const result = await client.callTool({
        name: 'score_hypothesis',
        arguments: { hypothesisId: rootId, score: 1.5 },
      });
      expect(result.isError).toBe(true);
    });

    it('error: score below 0', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const result = await client.callTool({
        name: 'score_hypothesis',
        arguments: { hypothesisId: rootId, score: -0.1 },
      });
      expect(result.isError).toBe(true);
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
          arguments: { parentId: rootId, children: ['Network', 'App code'] },
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
        arguments: { parentId: rootId, children: ['X', 'Y'] },
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
          arguments: { parentId: rootId, children: ['H1', 'H2', 'H3'] },
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

    it('detects stagnation', async () => {
      const { rootId } = parseResult(
        await client.callTool({ name: 'create_tree', arguments: { problem: 'Test' } }),
      );
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { parentId: rootId, children: ['A', 'B'] },
        }),
      );
      // 4 score mutations without status change = stagnation
      for (let i = 0; i < 4; i++) {
        await client.callTool({
          name: 'score_hypothesis',
          arguments: { hypothesisId: childIds[0], score: (i + 1) * 0.1 },
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
        arguments: { parentId: rootId, children: ['Network error', 'Network'] },
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
        arguments: { parentId: rootId, children: ['Specific cause', 'Other'] },
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
        arguments: { parentId: rootId, children: ['Network layer', 'Application layer', 'Data layer'] },
      });
      const result = await client.callTool({
        name: 'validate_decomposition',
        arguments: { parentId: rootId },
      });
      const text = getText(result);
      expect(text).toContain('No substring overlaps');
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
          arguments: {
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
      await client.callTool({
        name: 'score_hypothesis',
        arguments: { hypothesisId: l1[0], score: 0.8 },
      });

      // Level 2: Decompose the winning branch
      const { childIds: l2 } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: {
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
      await client.callTool({
        name: 'score_hypothesis',
        arguments: { hypothesisId: l2[0], score: 0.95 },
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
      const { childIds } = parseResult(
        await client.callTool({
          name: 'decompose',
          arguments: { parentId: rootId, children: ['Dep conflict', 'Syntax error'] },
        }),
      );

      // Agent realizes it missed something
      const addResult = await client.callTool({
        name: 'add_hypothesis',
        arguments: { parentId: rootId, content: 'Flaky test infrastructure' },
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
          arguments: { parentId: rootId, children: ['A', 'B', 'C'] },
        }),
      );

      // Every mutating tool should include tree summary
      const evResult = await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: childIds[0], type: 'supports', content: 'data' },
      });
      expect(getText(evResult)).toContain('Progress:');

      const scoreResult = await client.callTool({
        name: 'score_hypothesis',
        arguments: { hypothesisId: childIds[1], score: 0.6 },
      });
      expect(getText(scoreResult)).toContain('Progress:');

      const elimResult = await client.callTool({
        name: 'eliminate_hypothesis',
        arguments: { hypothesisId: childIds[2], reason: 'nope' },
      });
      expect(getText(elimResult)).toContain('Progress:');
    });
  });
});
