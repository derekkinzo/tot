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

  it('close() tears down the MCP server so further tool calls fail', async () => {
    // Graceful shutdown must close the MCP protocol layer, not just the HTTP
    // server — otherwise the transport lingers. After close(), the connected
    // client can no longer invoke tools.
    const s = await createSessionServer({ projectDir: projectDir });
    open.push(s);
    const client = await connect(s);
    // Sanity: the tool works before close.
    await client.callTool({ name: 'create_tree', arguments: { problem: 'pre-close' } });
    await s.close();
    await expect(
      client.callTool({ name: 'get_status', arguments: {} }),
    ).rejects.toThrow();
    try { await client.close(); } catch { /* already torn down */ }
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

  it('a restarted server reloads a fully-terminal tree and still surfaces its dashboard URL', async () => {
    // First process: build a tree and drive every branch to a terminal state.
    const s1 = await start();
    const c1 = await connect(s1);
    const { rootId } = parseResult(
      await c1.callTool({ name: 'create_tree', arguments: { problem: 'Terminal then reload' } }),
    );
    const { childIds } = parseResult(
      await c1.callTool({ name: 'decompose', arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] } }),
    );
    await c1.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'no' } });
    await c1.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'gone' } });
    await c1.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[1], type: 'supports', content: 'yes' } });
    await c1.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: childIds[1], reason: 'survives' } });
    await c1.close();
    await s1.close();

    // Second process: no session is open, but the reloaded tree is the project's
    // most recent, so the dashboard URL must still be discoverable and the
    // dashboard state endpoint must serve that tree.
    const s2 = await start();
    const c2 = await connect(s2);
    clients.push(c2);
    const status = getText(await c2.callTool({ name: 'get_status', arguments: {} }));
    expect(status).toContain('Terminal then reload');
    expect(status).toContain(`Visualization: ${s2.dashboardUrl}`);

    const state = await (await fetch(`http://localhost:${s2.port}/api/state`)).json();
    expect(state.session).not.toBeNull();
    expect(state.session.status).toBe('resolved');
    expect(state.hypotheses.length).toBe(3);
  });

  it('serves a fully-terminal tree over /api/state so the dashboard renders it after closure', async () => {
    // The dashboard default-session pick falls back to the most recent tree, so
    // a project whose only session has reached a terminal state must still
    // return that session (not an empty state) for the browser to render.
    const s = await start();
    const client = await connect(s);
    clients.push(client);

    const { rootId, sessionId } = parseResult(
      await client.callTool({ name: 'create_tree', arguments: { problem: 'Closes fully' } }),
    );
    const { childIds } = parseResult(
      await client.callTool({ name: 'decompose', arguments: { axis: 'by cause', parentId: rootId, children: ['A', 'B'] } }),
    );
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[0], type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: childIds[0], reason: 'gone' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: childIds[1], type: 'supports', content: 'yes' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: childIds[1], reason: 'survives' } });

    const state = await (await fetch(`http://localhost:${s.port}/api/state`)).json();
    expect(state.session).not.toBeNull();
    expect(state.session.id).toBe(sessionId);
    expect(state.session.status).toBe('resolved');
    expect(state.hypotheses.length).toBe(3);
  });

  it('an unmatched /api/* path returns 404 JSON, not the SPA HTML shell', async () => {
    // Unknown API routes must fail as 404 rather than falling through to the
    // single-page-app static fallback, which would return index.html with a 200
    // and make a client JSON.parse throw — masking the bad route.
    const s = await start();
    const resp = await fetch(`http://localhost:${s.port}/api/does-not-exist`);
    expect(resp.status).toBe(404);
    expect(resp.headers.get('content-type')).toMatch(/application\/json/);
    const body = await resp.json();
    expect(body.error).toBeTruthy();
  });

  it('the SSE initial snapshot honors a requested sessionId instead of always the default', async () => {
    // The dashboard streams one session at a time and reconnects on any network
    // blip. If the stream always snapshots the default (most-recent-open)
    // session, a user viewing an older session is silently reset to the default
    // on reconnect. The /sse endpoint must snapshot the session the client asks
    // for.
    const s = await start();
    const client = await connect(s);
    clients.push(client);

    // Two sessions; the second is the default (most recently created, open).
    const first = parseResult(await client.callTool({ name: 'create_tree', arguments: { problem: 'First session' } }));
    await client.callTool({ name: 'create_tree', arguments: { problem: 'Second session' } });

    // Connect to the stream scoped to the FIRST (non-default) session.
    const resp = await fetch(`http://localhost:${s.port}/sse?sessionId=${first.sessionId}`, {
      headers: { Accept: 'text/event-stream' },
    });
    const reader = resp.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    await reader.cancel();

    // The first SSE frame is the snapshot; it must describe the requested
    // session, not the default second one.
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'))!;
    const snapshot = JSON.parse(dataLine.slice('data:'.length).trim());
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.session.id).toBe(first.sessionId);
    expect(snapshot.session.problem).toBe('First session');
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

describe('reading a tree that is no longer the live one', () => {
  // /tot-export exists to export a COMPLETED tree and /tot-inspect to inspect any
  // tree, and both are documented as calling get_tree. A read surface that can
  // only reach the session already in memory cannot serve either: only one
  // session is loaded at boot, so every finished investigation is unreachable.
  let stateDir: string;
  let projectDir: string;
  const open: SessionServer[] = [];
  const clients: Client[] = [];
  const savedDataDir = process.env['TOT_DATA_DIR'];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'tot-read-state-'));
    projectDir = mkdtempSync(join(tmpdir(), 'tot-read-proj-'));
    process.env['TOT_DATA_DIR'] = stateDir;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
    for (const s of open.splice(0)) { try { await s.close(); } catch { /* ignore */ } }
    if (savedDataDir === undefined) delete process.env['TOT_DATA_DIR'];
    else process.env['TOT_DATA_DIR'] = savedDataDir;
    for (const d of [stateDir, projectDir]) rmSync(d, { recursive: true, force: true });
  });

  async function start(): Promise<{ s: SessionServer; client: Client }> {
    const s = await createSessionServer({ projectDir });
    open.push(s);
    const client = await connect(s);
    clients.push(client);
    return { s, client };
  }

  /** Builds a finished tree and a later, still-open one, then restarts. */
  async function twoSessionsThenRestart(): Promise<{ client: Client; finishedId: string; openId: string }> {
    const first = await start();
    const done = parseResult(await first.client.callTool({
      name: 'create_tree', arguments: { problem: 'the finished investigation', rootTitle: 'Finished' },
    }));
    const kids = parseResult(await first.client.callTool({
      name: 'decompose',
      arguments: { parentId: done.rootId, axis: 'by cause', children: ['Alpha', 'Beta'] },
    })).childIds;
    await first.client.callTool({ name: 'add_evidence', arguments: { hypothesisId: kids[0], type: 'refutes', content: 'ruled out' } });
    await first.client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: kids[0], reason: 'ruled out' } });
    await first.client.callTool({ name: 'set_out_of_scope', arguments: { hypothesisId: kids[1], reason: 'set aside' } });

    // A later session, which is the one a restart will load.
    const later = parseResult(await first.client.callTool({
      name: 'create_tree', arguments: { problem: 'the live investigation', rootTitle: 'Live' },
    }));

    await first.s.close();
    open.length = 0;
    const second = await start();
    return { client: second.client, finishedId: done.sessionId, openId: later.sessionId };
  }

  it('reads a finished tree when its session is named', async () => {
    const { client, finishedId } = await twoSessionsThenRestart();
    const res: any = await client.callTool({ name: 'get_tree', arguments: { format: 'compact', sessionId: finishedId } });
    expect(res.isError).toBeFalsy();
    expect(getText(res)).toContain('the finished investigation');
  });

  it('reads a finished tree in full form, which is what an export needs', async () => {
    const { client, finishedId } = await twoSessionsThenRestart();
    const res: any = await client.callTool({ name: 'get_tree', arguments: { format: 'full', sessionId: finishedId } });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(getText(res));
    expect(payload.session.id).toBe(finishedId);
    // Verdicts and reasons have to survive, or the export is not a record.
    const nodes: any[] = Object.values(payload.hypotheses);
    expect(nodes.map((n) => n.status).sort()).toEqual(['eliminated', 'exploring', 'out-of-scope']);
    expect(nodes.some((n) => n.conclusion?.reason === 'ruled out')).toBe(true);
  });

  it('still refuses a session id that names nothing', async () => {
    const { client } = await twoSessionsThenRestart();
    const res: any = await client.callTool({
      name: 'get_tree', arguments: { format: 'compact', sessionId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/No such session/);
  });

  it('agrees with get_status about which tree is current', async () => {
    // The two read surfaces resolving the default session differently is how a
    // caller ends up told there is no tree by one tool and shown one by the other.
    const { client } = await twoSessionsThenRestart();
    const status = getText(await client.callTool({ name: 'get_status', arguments: {} }));
    const tree = getText(await client.callTool({ name: 'get_tree', arguments: { format: 'compact' } }));
    const problemOf = (t: string) => (t.match(/the (finished|live) investigation/) || [])[0];
    expect(problemOf(status), `status said: ${status.slice(0, 120)}`).toBeTruthy();
    expect(problemOf(tree), `tree said: ${tree.slice(0, 120)}`).toBe(problemOf(status));
  });

  it('reads the only tree there is even after it has finished', async () => {
    // A single investigation, carried to a close, then reopened later: the whole
    // point of an audit trail.
    const first = await start();
    const done = parseResult(await first.client.callTool({
      name: 'create_tree', arguments: { problem: 'the only investigation', rootTitle: 'Only' },
    }));
    const kids = parseResult(await first.client.callTool({
      name: 'decompose', arguments: { parentId: done.rootId, axis: 'by cause', children: ['Alpha', 'Beta'] },
    })).childIds;
    for (const id of kids) {
      await first.client.callTool({ name: 'set_out_of_scope', arguments: { hypothesisId: id, reason: 'set aside' } });
    }
    await first.s.close();
    open.length = 0;

    const second = await start();
    const res: any = await second.client.callTool({ name: 'get_tree', arguments: { format: 'compact' } });
    expect(res.isError).toBeFalsy();
    expect(getText(res)).toContain('the only investigation');
  });
});

describe('enumerating a project\'s sessions', () => {
  let stateDir: string;
  let projectDir: string;
  const open: SessionServer[] = [];
  const clients: Client[] = [];
  const savedDataDir = process.env['TOT_DATA_DIR'];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'tot-list-state-'));
    projectDir = mkdtempSync(join(tmpdir(), 'tot-list-proj-'));
    process.env['TOT_DATA_DIR'] = stateDir;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
    for (const s of open.splice(0)) { try { await s.close(); } catch { /* ignore */ } }
    if (savedDataDir === undefined) delete process.env['TOT_DATA_DIR'];
    else process.env['TOT_DATA_DIR'] = savedDataDir;
    for (const d of [stateDir, projectDir]) rmSync(d, { recursive: true, force: true });
  });

  async function start(): Promise<{ s: SessionServer; client: Client }> {
    const s = await createSessionServer({ projectDir });
    open.push(s);
    const client = await connect(s);
    clients.push(client);
    return { s, client };
  }

  const problems = (n: number) => Array.from({ length: n }, (_, i) => `investigation number ${i + 1}`);

  it('counts and lists the same sessions, including one created after start-up', async () => {
    // The count and the list are read by one dashboard at one moment; a count
    // taken from the boot scan alone omits whatever was created since, and the
    // header then contradicts the selector beside it.
    const first = await start();
    await first.client.callTool({ name: 'create_tree', arguments: { problem: problems(1)[0] } });
    await first.s.close();
    open.length = 0;

    const second = await start();
    await second.client.callTool({ name: 'create_tree', arguments: { problem: 'created after start-up' } });

    const base = `http://localhost:${second.s.port}`;
    const info = await (await fetch(`${base}/api/info`)).json() as { sessionCount: number };
    const list = await (await fetch(`${base}/api/sessions`)).json() as { sessions: Array<{ id: string; problem: string }> };
    expect(list.sessions).toHaveLength(2);
    expect(info.sessionCount).toBe(list.sessions.length);
    expect(list.sessions.map((s) => s.problem)).toContain('created after start-up');
  });

  it('names the other sessions of the project, so their ids can be read and passed on', async () => {
    // A session id is only obtainable from a tool response. Without one for a
    // session that is not the current one, no caller can ask get_tree for it.
    const first = await start();
    const finished = parseResult(await first.client.callTool({
      name: 'create_tree', arguments: { problem: 'the earlier investigation' },
    }));
    await first.client.callTool({
      name: 'set_out_of_scope', arguments: { hypothesisId: finished.rootId, reason: 'set aside' },
    });
    const live = parseResult(await first.client.callTool({
      name: 'create_tree', arguments: { problem: 'the later investigation' },
    }));

    const status = getText(await first.client.callTool({ name: 'get_status', arguments: {} }));
    // The summarized session is identified by its short display form; the ones it
    // is not summarizing carry the full id, because that is what get_tree takes.
    expect(status).toContain(`Session: ${live.sessionId.slice(0, 8)}`);
    expect(status).toContain(finished.sessionId);
    expect(status).toContain('the earlier investigation');

    // And the id it hands out is one get_tree accepts.
    const res: any = await first.client.callTool({
      name: 'get_tree', arguments: { format: 'compact', sessionId: finished.sessionId },
    });
    expect(res.isError).toBeFalsy();
    expect(getText(res)).toContain('the earlier investigation');
  });

  it('bounds the list it prints and says how much of the project it is naming', async () => {
    // An unbounded list would grow with project history in a read-out the agent
    // calls constantly; a silent cut would read as the whole project.
    const { client } = await start();
    const ids: string[] = [];
    for (const problem of problems(9)) {
      ids.push(parseResult(await client.callTool({ name: 'create_tree', arguments: { problem } })).sessionId);
    }
    const status = getText(await client.callTool({ name: 'get_status', arguments: {} }));
    const named = ids.filter((id) => status.includes(id));
    expect(named).toHaveLength(5);            // five of the eight it is not summarizing
    expect(status).toContain('of 8 other sessions');
    // Newest first: the oldest sessions are the ones left out.
    expect(status).not.toContain(ids[0]);
  });

  it('summarizes the session it is asked about, not just the current one', async () => {
    // Both reporting skills advertise a sessionId argument. Silently ignoring one
    // answers about a different tree than the caller named.
    const first = await start();
    const earlier = parseResult(await first.client.callTool({
      name: 'create_tree', arguments: { problem: 'the earlier investigation' },
    }));
    await first.client.callTool({ name: 'create_tree', arguments: { problem: 'the later investigation' } });

    const asked = getText(await first.client.callTool({
      name: 'get_status', arguments: { sessionId: earlier.sessionId },
    }));
    expect(asked).toContain('the earlier investigation');
    expect(asked).toContain(`Session: ${earlier.sessionId.slice(0, 8)}`);

    // And it refuses an id that names nothing rather than answering about another.
    const bogus: any = await first.client.callTool({
      name: 'get_status', arguments: { sessionId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(bogus.isError).toBe(true);
    expect(getText(bogus)).toMatch(/No such session/);
  });

  it('publishes the dashboard address before any tree exists', async () => {
    // The port is ephemeral and this response is the only place it is published;
    // the dashboard itself serves an empty state, so the address is usable.
    const { s, client } = await start();
    const status = getText(await client.callTool({ name: 'get_status', arguments: {} }));
    expect(status).toContain('No session yet for this project');
    expect(status).toContain(`Visualization: ${s.dashboardUrl}`);
  });

  it('says nothing about other sessions when the project has only one', async () => {
    const { client } = await start();
    await client.callTool({ name: 'create_tree', arguments: { problem: 'the only investigation' } });
    const status = getText(await client.callTool({ name: 'get_status', arguments: {} }));
    expect(status).not.toContain('other session');
    expect(status).not.toContain('Also in this project');
  });
});
