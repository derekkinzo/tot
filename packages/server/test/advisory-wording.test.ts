import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TreeManager } from '../src/tree-manager.js';
import { registerTools } from '../src/tools.js';

/**
 * What an advisory is allowed to assert.
 *
 * Every advisory fires on a structural test over the tree. The prose it carries
 * may state what that test observed and what to do about it; it may not state a
 * conclusion the test cannot reach. A reader who acts on an advisory has to be
 * able to trust that the thing it describes is the thing that was measured.
 */
describe('advisory wording stays inside what was observed', () => {
  let client: Client;

  beforeEach(async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerTools(server, new TreeManager({}), () => '/tmp/tot-advisory-test');
    client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
  });

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[] };
    return res.content.find((c) => c.type === 'text')?.text ?? '';
  }

  async function rootId(): Promise<string> {
    return JSON.parse((await call('create_tree', { problem: 'why is the checkout slow' })).split('\n')[0]).rootId;
  }

  describe('a record spanning several lines with no captured bytes', () => {
    // The test behind this advisory is: the newest record cites no artifact and
    // its content contains a newline. That distinguishes nothing about where the
    // text came from — a two-line note an operator wrote by hand satisfies it.

    const MULTILINE_NOTE = 'Checked with the on-call engineer.\nThey confirmed the alarm fired twice.';

    it('does not state as fact that the text was retyped from output', async () => {
      const id = await rootId();
      const text = await call('add_evidence', {
        hypothesisId: id, type: 'supports', content: MULTILINE_NOTE,
      });
      expect(text).not.toMatch(/was retyped into it|is a retelling|carries output that was/i);
    });

    it('says what it observed and what to do about it', async () => {
      const id = await rootId();
      const text = await call('add_evidence', {
        hypothesisId: id, type: 'supports', content: MULTILINE_NOTE,
      });
      // The observation is the shape of the record; the action is the capture.
      expect(text).toMatch(/several lines|multiple lines|more than one line/i);
      expect(text).toMatch(/artifactPath/);
    });

    it('says nothing at all once the record cites captured bytes', async () => {
      // Nothing to advise: the bytes are already stored and re-readable.
      const id = await rootId();
      const text = await call('add_evidence', {
        hypothesisId: id, type: 'supports', content: MULTILINE_NOTE,
        artifactPath: new URL('./advisory-wording.test.ts', import.meta.url).pathname,
      });
      expect(text).not.toMatch(/artifactPath so the bytes/i);
    });
  });

  describe('evidence weight', () => {
    it('does not call records independent, which nothing establishes', async () => {
      // Independence is the default a record gets by not declaring a link, not a
      // property the system checked. Two records copied from one dashboard are
      // counted as two unless the agent says otherwise.
      const id = await rootId();
      await call('add_evidence', { hypothesisId: id, type: 'refutes', content: 'the p99 did not move' });
      const text = await call('add_evidence', { hypothesisId: id, type: 'refutes', content: 'the queue stayed flat' });
      expect(text).not.toMatch(/\bindependent(ly)?\b/i);
    });
  });
});
