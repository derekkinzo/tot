import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSessionServer, type SessionServer } from '../src/per-session.js';
import { getCentralSessionsDir, hashProjectDir } from '../src/central-storage.js';

function getText(result: any): string {
  return result.content?.find((c: any) => c.type === 'text')?.text ?? '';
}
function parseResult(result: any): any {
  const text = getText(result);
  try { return JSON.parse(text.split('\n')[0]); } catch { return { raw: text }; }
}

/** Connect an in-memory MCP client to a SessionServer's McpServer. */
async function connect(session: SessionServer): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), session.server.connect(st)]);
  return client;
}

describe('per-session server', () => {
  let stateDir: string;   // TOT_DATA_DIR root
  let projectDir: string; // a fake project working directory
  const open: SessionServer[] = [];
  const clients: Client[] = [];
  const savedEnv = { ...process.env };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'tot-state-'));
    projectDir = mkdtempSync(join(tmpdir(), 'tot-proj-'));
    process.env['TOT_DATA_DIR'] = stateDir;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
    for (const s of open.splice(0)) { try { await s.close(); } catch { /* ignore */ } }
    for (const k of ['TOT_DATA_DIR']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  async function start(dir = projectDir): Promise<SessionServer> {
    const s = await createSessionServer({ projectDir: dir });
    open.push(s);
    return s;
  }

  it('binds an ephemeral (non-zero, OS-assigned) port and exposes its dashboard URL', async () => {
    const s = await start();
    // listen(0) must yield a real, bound port — never 0 and never a fixed default.
    expect(s.port).not.toBeNull();
    expect(s.port).toBeGreaterThan(0);
    expect(s.dashboardUrl).toBe(`http://localhost:${s.port}`);
  });

  it('close() is idempotent and the port stops accepting connections afterward', async () => {
    const s = await createSessionServer({ projectDir: projectDir });
    const port = s.port!;
    // Concurrent + repeated close() must all resolve (single-flight), not hang
    // or double-tear-down.
    await Promise.all([s.close(), s.close()]);
    await s.close();
    // The HTTP server is down: a fetch to the old port now fails to connect.
    await expect(fetch(`http://localhost:${port}/api/info`)).rejects.toThrow();
  });

  it('flips persistenceHealthy via onPersistenceError when a journal append fails', async () => {
    // A failed JSONL append must surface through onPersistenceError so the
    // dashboard's /api/info can report the project as unhealthy.
    const projForFail = mkdtempSync(join(tmpdir(), 'tot-projfail-'));
    const s = await createSessionServer({ projectDir: projForFail });
    open.push(s);
    const client = await connect(s);
    clients.push(client);

    // Make the sessions dir read-only so appendFile (creating <sid>.jsonl)
    // fails with EACCES — the dir already exists, so Persistence's mkdirSync
    // is a no-op and the failure lands on the append, not construction.
    mkdirSync(s.dataDir, { recursive: true });
    chmodSync(s.dataDir, 0o555);
    try {
      await client.callTool({ name: 'create_tree', arguments: { problem: 'health probe' } });

      const info = await (await fetch(`http://localhost:${s.port}/api/info`)).json();
      expect(info.projectDir).toBe(s.projectDir);
      expect(info.persistenceHealthy).toBe(false);
    } finally {
      chmodSync(s.dataDir, 0o755); // restore so afterEach cleanup can remove it
      rmSync(projForFail, { recursive: true, force: true });
    }
  });

  it('two servers for the same project bind different ephemeral ports', async () => {
    const a = await start();
    const b = await start();
    expect(a.port).not.toBe(b.port);
  });

  it('get_status surfaces the live dashboard URL (the agent\'s own process is the source of truth)', async () => {
    const s = await start();
    const client = await connect(s);
    clients.push(client);
    await client.callTool({ name: 'create_tree', arguments: { problem: 'Boot URL check' } });
    const text = getText(await client.callTool({ name: 'get_status', arguments: {} }));
    expect(text).toContain(`Visualization: ${s.dashboardUrl}`);
  });

  it('writes session journals under central storage keyed by the project hash, not in the project dir', async () => {
    const s = await start();
    const client = await connect(s);
    clients.push(client);
    await client.callTool({ name: 'create_tree', arguments: { problem: 'Where do I live' } });

    const centralSessions = join(stateDir, 'projects', hashProjectDir(projectDir), 'sessions');
    expect(s.dataDir).toBe(centralSessions);
    const journals = readdirSync(centralSessions).filter((f) => f.endsWith('.jsonl'));
    expect(journals).toHaveLength(1);
    // The repo / project dir must stay clean — no per-project .tot is created.
    expect(existsSync(join(projectDir, '.tot'))).toBe(false);
  });

  it('reloads an existing tree from central storage on restart', async () => {
    // First process: build a tree, then shut down.
    const s1 = await start();
    const c1 = await connect(s1);
    const { sessionId } = parseResult(
      await c1.callTool({ name: 'create_tree', arguments: { problem: 'Survives restart' } }),
    );
    await c1.close();
    await s1.close();

    // Second process for the same project: the prior session must be visible
    // (reloaded from the JSONL journal), proving durability without a daemon.
    const s2 = await start();
    const c2 = await connect(s2);
    clients.push(c2);
    const text = getText(await c2.callTool({ name: 'get_tree', arguments: { format: 'compact' } }));
    expect(text).toContain('Survives restart');

    const full = JSON.parse(getText(await c2.callTool({ name: 'get_tree', arguments: { format: 'full' } })));
    expect(full.session.id).toBe(sessionId);
  });

  it('migrates legacy {projectDir}/.tot/sessions journals into central storage on startup (non-destructive)', async () => {
    // A pre-migration journal living in the old per-project location.
    const legacyDir = join(projectDir, '.tot', 'sessions');
    mkdirSync(legacyDir, { recursive: true });
    const legacyFile = join(legacyDir, 'legacy-sess.jsonl');
    const session = { id: 'legacy-sess', problem: 'Old tree', rootNodeId: 'root-1', status: 'open', createdAt: '2020-01-01T00:00:00.000Z' };
    const root = { id: 'root-1', parentId: null, sessionId: 'legacy-sess', depth: 0, content: 'Old tree', status: 'exploring', evidence: [], metadata: {}, children: [] };
    writeFileSync(legacyFile, [
      JSON.stringify({ timestamp: '2020-01-01T00:00:00.000Z', type: 'session-created', payload: session }),
      JSON.stringify({ timestamp: '2020-01-01T00:00:01.000Z', type: 'hypothesis-added', payload: root }),
    ].join('\n') + '\n');

    const s = await start();
    const client = await connect(s);
    clients.push(client);

    // The legacy session is now reloadable from central storage…
    const central = join(getCentralSessionsDir(projectDir), 'legacy-sess.jsonl');
    expect(existsSync(central)).toBe(true);
    // …and the original is preserved (copy, not move).
    expect(existsSync(legacyFile)).toBe(true);

    const text = getText(await client.callTool({ name: 'get_tree', arguments: { format: 'compact' } }));
    expect(text).toContain('Old tree');
  });
});
