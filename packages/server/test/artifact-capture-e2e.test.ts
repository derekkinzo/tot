import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSessionServer, type SessionServer } from '../src/per-session.js';
import { getCentralArtifactsDir } from '../src/central-storage.js';

/**
 * Capturing verbatim evidence, end to end: an agent points at a log on disk, the
 * bytes are snapshotted, the record cites them, and the dashboard reads them
 * back over HTTP.
 */
describe('verbatim evidence capture, end to end', () => {
  let stateDir: string;
  let projectDir: string;
  let logDir: string;
  const open: SessionServer[] = [];
  const clients: Client[] = [];
  const savedDataDir = process.env['TOT_DATA_DIR'];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'tot-state-'));
    projectDir = mkdtempSync(join(tmpdir(), 'tot-proj-'));
    logDir = mkdtempSync(join(tmpdir(), 'tot-logs-'));
    process.env['TOT_DATA_DIR'] = stateDir;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
    for (const s of open.splice(0)) { try { await s.close(); } catch { /* ignore */ } }
    if (savedDataDir === undefined) delete process.env['TOT_DATA_DIR'];
    else process.env['TOT_DATA_DIR'] = savedDataDir;
    for (const d of [stateDir, projectDir, logDir]) rmSync(d, { recursive: true, force: true });
  });

  async function start(): Promise<{ s: SessionServer; client: Client }> {
    const s = await createSessionServer({ projectDir });
    open.push(s);
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), s.server.connect(st)]);
    clients.push(client);
    return { s, client };
  }

  function log(name: string, body: string): string {
    const p = join(logDir, name);
    writeFileSync(p, body);
    return p;
  }

  /** Every file holding bytes in this project's artifact store. An emptied
   *  session directory holds none, so only files are counted. */
  function storedIds(): string[] {
    const dir = getCentralArtifactsDir(projectDir);
    if (!existsSync(dir)) return [];
    return (readdirSync(dir, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  }

  const LOG_BODY = Array.from({ length: 12 }, (_, i) => `line ${i + 1}: assertion output`).join('\n') + '\n';

  /** Creates a tree, returning the session and root hypothesis ids. */
  async function newTree(client: Client): Promise<{ sessionId: string; rootId: string }> {
    const res: any = await client.callTool({ name: 'create_tree', arguments: { problem: 'why does the build fail' } });
    const text = res.content?.find((c: any) => c.type === 'text')?.text ?? '';
    const ids = JSON.parse(text.split('\n')[0]);
    expect(ids.rootId).toBeTruthy();
    return ids;
  }

  async function rootOf(client: Client): Promise<string> {
    return (await newTree(client)).rootId;
  }

  async function state(s: SessionServer): Promise<any> {
    return (await fetch(`http://localhost:${s.port}/api/state`)).json();
  }

  it('does not offer the tree or the captured bytes to other origins', async () => {
    // The dashboard is served by this same server, so it needs no cross-origin
    // grant. A wildcard one lets any page the developer happens to have open read
    // /api/state, take the artifact ids out of it, and then read the bytes of
    // whatever files were captured off their disk.
    const { s, client } = await start();
    const rootId = await rootOf(client);
    await client.callTool({
      name: 'add_evidence',
      arguments: {
        hypothesisId: rootId, type: 'refutes', content: 'x',
        artifactPath: log('secret.log', LOG_BODY),
      },
    });
    const { hypotheses } = await state(s);
    const ref = hypotheses.find((h: any) => h.id === rootId).evidence[0].artifact;

    const routes = [
      '/api/state',
      '/api/info',
      `/api/artifacts/${ref.sessionId}/${ref.id}/meta`,
      `/api/artifacts/${ref.sessionId}/${ref.id}/raw`,
      `/api/artifacts/${ref.sessionId}/${ref.id}/lines?from=1&to=5`,
    ];
    for (const route of routes) {
      const res = await fetch(`http://localhost:${s.port}${route}`);
      expect(res.status, route).toBeLessThan(400);
      expect(res.headers.get('access-control-allow-origin'), `${route} grants any origin`).toBeNull();
    }
  });

  it('stores the bytes and records them as verbatim, without the agent retyping them', async () => {
    const { s, client } = await start();
    const rootId = await rootOf(client);

    const res: any = await client.callTool({
      name: 'add_evidence',
      arguments: {
        hypothesisId: rootId, type: 'refutes',
        content: 'the linker step fails before the test phase runs',
        artifactPath: log('build.log', LOG_BODY),
        command: 'npm run build', exitCode: 1,
      },
    });
    expect(res.isError).toBeFalsy();

    const { hypotheses } = await state(s);
    const evidence = hypotheses.find((h: any) => h.id === rootId).evidence[0];
    // Verbatim is derived from the capture, never asked for, so the label and
    // the bytes cannot disagree.
    expect(evidence.kind).toBe('artifact');
    expect(evidence.artifact.filename).toBe('build.log');
    expect(evidence.artifact.command).toBe('npm run build');
    expect(evidence.artifact.exitCode).toBe(1);
    expect(evidence.artifact.lineCount).toBe(12);
    // The stored copy is byte-identical to what the agent observed.
    const stored = join(getCentralArtifactsDir(projectDir), evidence.artifact.sessionId, evidence.artifact.id);
    expect(readFileSync(stored, 'utf-8')).toBe(LOG_BODY);
  });

  it('records a transcription when no file backs the claim', async () => {
    const { s, client } = await start();
    const rootId = await rootOf(client);
    await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: rootId, type: 'supports', content: 'I recall seeing a timeout' },
    });
    const { hypotheses } = await state(s);
    const evidence = hypotheses.find((h: any) => h.id === rootId).evidence[0];
    expect(evidence.kind).toBe('transcription');
    expect(evidence.artifact).toBeUndefined();
  });

  it('survives a restart: the reference replays and still resolves to the same bytes', async () => {
    const { s, client } = await start();
    const rootId = await rootOf(client);
    await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: rootId, type: 'refutes', content: 'see the log', artifactPath: log('a.log', LOG_BODY) },
    });
    await s.close();

    const revived = await createSessionServer({ projectDir });
    open.push(revived);
    const { hypotheses } = await state(revived);
    const evidence = hypotheses.find((h: any) => h.id === rootId).evidence[0];
    expect(evidence.kind).toBe('artifact');

    const meta = await (await fetch(
      `http://localhost:${revived.port}/api/artifacts/${evidence.artifact.sessionId}/${evidence.artifact.id}/meta`,
    )).json();
    expect(meta.integrity).toBe('verified');
  });

  it('serves a line window of the artifact so a viewer can page a long log', async () => {
    const { s, client } = await start();
    const rootId = await rootOf(client);
    await client.callTool({
      name: 'add_evidence',
      arguments: {
        hypothesisId: rootId, type: 'refutes', content: 'fails at line 7',
        artifactPath: log('a.log', LOG_BODY), excerptStartLine: 7, excerptEndLine: 8,
      },
    });
    const { hypotheses } = await state(s);
    const { artifact } = hypotheses.find((h: any) => h.id === rootId).evidence[0];
    expect(artifact.excerpt).toEqual({ startLine: 7, endLine: 8 });

    const base = `http://localhost:${s.port}/api/artifacts/${artifact.sessionId}/${artifact.id}`;
    const window = await (await fetch(`${base}/lines?from=7&to=8`)).json();
    expect(window.lines).toEqual(['line 7: assertion output', 'line 8: assertion output']);
    expect(window.totalLines).toBe(12);

    const raw = await fetch(`${base}/raw`);
    expect(raw.headers.get('content-type')).toBe('text/plain');
    expect(await raw.text()).toBe(LOG_BODY);
  });

  it('reads a single cited line from a start alone, rather than dropping the citation', async () => {
    const { s, client } = await start();
    const rootId = await rootOf(client);
    await client.callTool({
      name: 'add_evidence',
      arguments: {
        hypothesisId: rootId, type: 'refutes', content: 'line 4 is the one',
        artifactPath: log('a.log', LOG_BODY), excerptStartLine: 4,
      },
    });
    const { hypotheses } = await state(s);
    expect(hypotheses.find((h: any) => h.id === rootId).evidence[0].artifact.excerpt)
      .toEqual({ startLine: 4, endLine: 4 });
  });

  it('refuses an end line with no start, which cites nothing', async () => {
    const { s, client } = await start();
    const rootId = await rootOf(client);
    const res: any = await client.callTool({
      name: 'add_evidence',
      arguments: {
        hypothesisId: rootId, type: 'refutes', content: 'x',
        artifactPath: log('a.log', LOG_BODY), excerptEndLine: 9,
      },
    });
    expect(res.isError).toBe(true);
    expect(storedIds()).toEqual([]);
  });

  it('refuses an excerpt that starts past the end of the captured bytes', async () => {
    // The capture measures the file, so it can tell that the cited line does not
    // exist. Journaling the citation anyway leaves a record whose own viewer
    // cannot open it.
    const { client } = await start();
    const rootId = await rootOf(client);
    const res: any = await client.callTool({
      name: 'add_evidence',
      arguments: {
        hypothesisId: rootId, type: 'supports', content: 'x',
        artifactPath: log('short.log', LOG_BODY), excerptStartLine: 99,
      },
    });
    expect(res.isError).toBe(true);
    expect(storedIds()).toEqual([]);
  });

  describe('fields that only describe a capture', () => {
    // Each of these says something about bytes. Accepting one with no artifact to
    // attach it to drops it silently, and the caller is told the record was
    // stored as asked.
    const DESCRIBES_A_CAPTURE = [
      { excerptStartLine: 3 },
      { excerptEndLine: 9 },
      { excerptStartLine: 3, excerptEndLine: 9 },
      { command: 'npm run build' },
      { exitCode: 1 },
    ];

    for (const extra of DESCRIBES_A_CAPTURE) {
      it(`refuses ${Object.keys(extra).join(' + ')} with no artifact to attach it to`, async () => {
        const { client } = await start();
        const rootId = await rootOf(client);
        const res: any = await client.callTool({
          name: 'add_evidence',
          arguments: { hypothesisId: rootId, type: 'supports', content: 'transcribed by hand', ...extra },
        });
        expect(res.isError).toBe(true);
        expect(String(res.content?.[0]?.text)).toMatch(/artifactPath/);
      });
    }

    it('still accepts a record that describes no capture at all', async () => {
      const { s, client } = await start();
      const rootId = await rootOf(client);
      const res: any = await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'supports', content: 'observed in the dashboard' },
      });
      expect(res.isError).toBeFalsy();
      const { hypotheses } = await state(s);
      expect(hypotheses.find((h: any) => h.id === rootId).evidence[0].kind).toBe('transcription');
    });
  });

  it('refuses a descending line range instead of storing one nothing can render', async () => {
    const { client } = await start();
    const rootId = await rootOf(client);
    const res: any = await client.callTool({
      name: 'add_evidence',
      arguments: {
        hypothesisId: rootId, type: 'refutes', content: 'x',
        artifactPath: log('a.log', LOG_BODY), excerptStartLine: 9, excerptEndLine: 4,
      },
    });
    expect(res.isError).toBe(true);
    expect(storedIds()).toEqual([]);
  });

  it('refuses an id that is not cited by any record, so stored bytes cannot be probed', async () => {
    const { s, client } = await start();
    const rootId = await rootOf(client);
    await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: rootId, type: 'refutes', content: 'x', artifactPath: log('a.log', LOG_BODY) },
    });
    const { hypotheses } = await state(s);
    const { sessionId } = hypotheses.find((h: any) => h.id === rootId).evidence[0].artifact;

    const stranger = '99999999-9999-4999-8999-999999999999';
    expect((await fetch(`http://localhost:${s.port}/api/artifacts/${sessionId}/${stranger}/raw`)).status).toBe(404);
  });

  it('answers a malformed artifact request with a rejection, not a served path', async () => {
    const { s } = await start();
    const base = `http://localhost:${s.port}/api/artifacts`;
    const sess = '11111111-1111-4111-8111-111111111111';
    for (const path of [`${base}/${sess}/not-an-id/raw`, `${base}/${sess}/${sess}/unknown`]) {
      expect((await fetch(path)).status).toBe(400);
    }
  });

  it('reports a missing source instead of filing an unbacked record', async () => {
    const { s, client } = await start();
    const rootId = await rootOf(client);
    const res: any = await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: rootId, type: 'refutes', content: 'x', artifactPath: join(logDir, 'ghost.log') },
    });
    expect(res.isError).toBe(true);
    // The refused call filed nothing at all.
    const { hypotheses } = await state(s);
    expect(hypotheses.find((h: any) => h.id === rootId).evidence).toHaveLength(0);
  });

  it('leaves no stored bytes behind when the mutation is refused after the capture ran', async () => {
    // The capture succeeds and the engine then rejects the record, which is the
    // only ordering where bytes exist with nothing to reference them.
    const { s, client } = await start();
    const rootId = await rootOf(client);
    const children: any = await client.callTool({
      name: 'decompose',
      arguments: { axis: 'by cause', parentId: rootId, children: ['the linker', 'the test runner'] },
    });
    expect(children.isError).toBeFalsy();
    const { hypotheses } = await state(s);
    const leaves = hypotheses.filter((h: any) => h.parentId === rootId);
    expect(leaves).toHaveLength(2);
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: leaves[0].id, type: 'refutes', content: 'no' } });
    await client.callTool({ name: 'eliminate_hypothesis', arguments: { hypothesisId: leaves[0].id, reason: 'ruled out' } });
    await client.callTool({ name: 'add_evidence', arguments: { hypothesisId: leaves[1].id, type: 'supports', content: 'yes' } });
    await client.callTool({ name: 'corroborate_hypothesis', arguments: { hypothesisId: leaves[1].id, reason: 'survives' } });
    const before = storedIds();

    const res: any = await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: leaves[1].id, type: 'supports', content: 'more', artifactPath: log('late.log', LOG_BODY) },
    });
    expect(res.isError).toBe(true);
    expect(storedIds()).toEqual(before);
  });

  it('keeps the bytes a filed record cites even when the journal write failed', async () => {
    // The record exists in memory and is broadcast to the dashboard. Deleting the
    // bytes it cites strands it: the integrity check then reports them gone, in
    // the same words it uses for real loss or tampering, for the server's own
    // housekeeping.
    const { s, client } = await start();
    const { sessionId, rootId } = await newTree(client);
    const journal = join(s.dataDir, `${sessionId}.jsonl`);
    chmodSync(journal, 0o444);
    let res: any;
    try {
      res = await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'refutes', content: 'x', artifactPath: log('b.log', LOG_BODY) },
      });
    } finally {
      chmodSync(journal, 0o644);
    }
    // The caller is still told the change is not durable — that is the message
    // that matters, because repeating the call is what makes it durable.
    expect(res.isError).toBe(true);
    expect(String(res.content?.[0]?.text)).toMatch(/lost on restart/i);

    // And the record it left behind still resolves to its bytes.
    const { hypotheses } = await state(s);
    const ref = hypotheses.find((h: any) => h.id === rootId).evidence[0].artifact;
    const meta = await (await fetch(
      `http://localhost:${s.port}/api/artifacts/${ref.sessionId}/${ref.id}/meta`)).json();
    expect(meta.integrity).toBe('verified');
  });

  it('still resolves the bytes after a failed write is followed by a successful one', async () => {
    // The evidence array rides inside the whole-node snapshot, so the next
    // successful mutation on that node makes the earlier record durable. Bytes
    // discarded at the failed write would leave a replayed verdict citing
    // evidence the server itself deleted — permanently.
    const { s, client } = await start();
    const { sessionId, rootId } = await newTree(client);
    const journal = join(s.dataDir, `${sessionId}.jsonl`);
    chmodSync(journal, 0o444);
    try {
      await client.callTool({
        name: 'add_evidence',
        arguments: { hypothesisId: rootId, type: 'refutes', content: 'refuted by the capture', artifactPath: log('c.log', LOG_BODY) },
      });
    } finally {
      chmodSync(journal, 0o644);
    }
    // A later successful mutation on the same node journals the whole node,
    // carrying the earlier record with it.
    const done: any = await client.callTool({
      name: 'eliminate_hypothesis',
      arguments: { hypothesisId: rootId, reason: 'refuted by the capture' },
    });
    expect(done.isError).toBeFalsy();

    // Reload the project from disk: the verdict's own evidence must still verify.
    const reopened = await start();
    const { hypotheses } = await state(reopened.s);
    const node = hypotheses.find((h: any) => h.id === rootId);
    expect(node.status).toBe('eliminated');
    const ref = node.evidence.find((e: any) => e.artifact)?.artifact;
    expect(ref, 'the replayed verdict cites no capture').toBeTruthy();
    const meta = await (await fetch(
      `http://localhost:${reopened.s.port}/api/artifacts/${ref.sessionId}/${ref.id}/meta`)).json();
    expect(meta.integrity).toBe('verified');
  });

  it('leaves no stored bytes behind when the mutation is refused', async () => {
    // A capture whose record was rejected would otherwise leave bytes nothing
    // references — and no read path could ever reach them again.
    const { client } = await start();
    await rootOf(client);
    const res: any = await client.callTool({
      name: 'add_evidence',
      arguments: { hypothesisId: 'no-such-node', type: 'refutes', content: 'x', artifactPath: log('a.log', LOG_BODY) },
    });
    expect(res.isError).toBe(true);
    expect(storedIds()).toEqual([]);
  });
});
