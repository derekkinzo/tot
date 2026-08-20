import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TreeManager } from '../src/tree-manager.js';
import { registerTools } from '../src/tools.js';

/**
 * How a decomposition declares its children relate, and what the tool surface
 * says when the verdicts recorded under it contradict that declaration.
 */
describe('declared splits at the tool surface', () => {
  let client: Client;
  let tm: TreeManager;

  beforeEach(async () => {
    tm = new TreeManager({});
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerTools(server, tm, () => '/tmp/tot-test');
    client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
  });

  async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = await client.callTool({ name, arguments: args }) as {
      content: { type: string; text: string }[]; isError?: boolean;
    };
    return { text: res.content.find((c) => c.type === 'text')?.text ?? '', isError: res.isError === true };
  }

  async function tree(): Promise<string> {
    const { text } = await call('create_tree', { problem: 'why is the checkout timing out' });
    return JSON.parse(text.split('\n')[0]).rootId;
  }

  async function split(parentId: string, children: string[], axis: string, gate?: string): Promise<string[]> {
    const { text } = await call('decompose', { parentId, children, axis, ...(gate ? { gate } : {}) });
    return JSON.parse(text.split('\n')[0]).childIds;
  }

  /** Settles a node as corroborated, which requires supporting evidence first. */
  async function corroborate(id: string): Promise<string> {
    await call('add_evidence', { hypothesisId: id, type: 'supports', content: 'the traces show it' });
    return (await call('corroborate_hypothesis', { hypothesisId: id, reason: 'survived the tests applied' })).text;
  }

  async function eliminate(id: string): Promise<string> {
    await call('add_evidence', { hypothesisId: id, type: 'refutes', content: 'the traces rule it out' });
    return (await call('eliminate_hypothesis', { hypothesisId: id, reason: 'refuted by the traces' })).text;
  }

  it('refuses a decomposition that does not state the axis its children divide', async () => {
    // Siblings cannot be judged for overlap or coverage without the dimension
    // they are meant to divide, so the axis is not optional.
    const rootId = await tree();
    const res = await call('decompose', { parentId: rootId, children: ['the database', 'the network'] });
    expect(res.isError).toBe(true);
  });

  it('restates the axis and what the declared relation means', async () => {
    const rootId = await tree();
    const { text } = await call('decompose', {
      parentId: rootId, children: ['the database', 'the network'],
      axis: 'by subsystem', gate: 'one-of',
    });
    expect(text).toContain('by subsystem');
    expect(text.toLowerCase()).toMatch(/one of/);
    expect(text.toLowerCase()).toMatch(/at most one|only one|exactly one/);
  });

  it('asks for the relation when it was left undeclared', async () => {
    const rootId = await tree();
    const { text } = await call('decompose', { parentId: rootId, children: ['a', 'b'], axis: 'by subsystem' });
    expect(text).toMatch(/one-of/);
    expect(text).toMatch(/all-of/);
  });

  it('flags two corroborated rivals under a one-of split', async () => {
    const rootId = await tree();
    const [a, b] = await split(rootId, ['the database', 'the network'], 'by subsystem', 'one-of');
    await corroborate(a);
    const text = await corroborate(b);
    expect(text).toMatch(/mutually exclusive|rivals/i);
  });

  it('flags two corroborated rivals while the split still has a branch open', async () => {
    // The conflict is a property of the verdicts, not of session closure. With a
    // third child left pending the session stays open, and the warning has to
    // reach the agent at the moment it is created — that is when it can still
    // act on it.
    const rootId = await tree();
    const [a, b] = await split(rootId, ['the database', 'the network', 'the client'], 'by subsystem', 'one-of');
    await corroborate(a);
    const text = await corroborate(b);
    expect(text).toMatch(/mutually exclusive|rivals/i);
  });

  it('does not flag two corroborated alternatives under an any-of split', async () => {
    // Several contributing causes are first-class, so this is only a conflict
    // when the children were declared exclusive.
    const rootId = await tree();
    const [a, b] = await split(rootId, ['the database', 'the network'], 'by subsystem', 'any-of');
    await corroborate(a);
    const text = await corroborate(b);
    expect(text).not.toMatch(/mutually exclusive/i);
  });

  it('flags a defeated part under an all-of split, which the parent rests on', async () => {
    const rootId = await tree();
    const [a] = await split(rootId, ['the retry budget is exhausted', 'the upstream is slow'], 'by required condition', 'all-of');
    const text = await eliminate(a);
    expect(text).toMatch(/cannot hold|no longer stands/i);
  });

  it('flags every alternative ruled out under a one-of split', async () => {
    const rootId = await tree();
    const [a, b] = await split(rootId, ['the database', 'the network'], 'by subsystem', 'one-of');
    await eliminate(a);
    const text = await eliminate(b);
    expect(text).toMatch(/every alternative|ruled out/i);
  });

  it('says nothing about a split that was never given a relation', async () => {
    const rootId = await tree();
    const [a, b] = await split(rootId, ['the database', 'the network'], 'by subsystem');
    await corroborate(a);
    const text = await corroborate(b);
    expect(text).not.toMatch(/mutually exclusive|required part/i);
  });

  it('reports the split alongside the structural checks when validating it', async () => {
    const rootId = await tree();
    await split(rootId, ['the database', 'the network'], 'by subsystem', 'one-of');
    const { text } = await call('validate_decomposition', { parentId: rootId });
    expect(text).toContain('by subsystem');
    expect(text.toLowerCase()).toContain('one of');
  });

  it('carries the split through the tree view, so a reader sees how siblings relate', async () => {
    const rootId = await tree();
    await split(rootId, ['the database', 'the network'], 'by subsystem', 'all-of');
    const { text } = await call('get_tree', {});
    expect(text).toContain('by subsystem');
  });

  it('refuses to re-split a node, keeping the declaration true of its children', async () => {
    // A second split appends to the same child list, so replacing the record
    // would leave 'by timing' describing two children divided by subsystem —
    // and the gate check would then report conflicts across both splits.
    const rootId = await tree();
    await split(rootId, ['the database', 'the network'], 'by subsystem', 'one-of');
    const again = await call('decompose', {
      parentId: rootId, children: ['before the deploy', 'after the deploy'],
      axis: 'by timing', gate: 'any-of',
    });
    expect(again.isError).toBe(true);
    expect(tm.getHypothesis(rootId)!.decomposition).toEqual({ axis: 'by subsystem', gate: 'one-of' });
    expect(tm.getHypothesis(rootId)!.children).toHaveLength(2);
  });

  it('points a caller with a missing sibling at add_hypothesis', async () => {
    const rootId = await tree();
    await split(rootId, ['the database', 'the network'], 'by subsystem', 'one-of');
    const again = await call('decompose', {
      parentId: rootId, children: ['the cache', 'the queue'], axis: 'by subsystem',
    });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/add_hypothesis/);
  });
});
