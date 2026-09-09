import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { statusLines } from '../src/status-report.js';
import { getCentralProjectDir, getCentralSessionsDir, writeProjectMeta } from '../src/central-storage.js';
import { JOURNAL_SCHEMA_VERSION } from '../src/replay.js';

const ts = '2024-01-01T00:00:00.000Z';
const line = (type: string, payload: unknown) =>
  JSON.stringify({ v: JOURNAL_SCHEMA_VERSION, timestamp: ts, type, payload }) + '\n';

describe('the status read-out of a project', () => {
  let root: string;
  let projectDir: string;
  const savedRoot = process.env['TOT_DATA_DIR'];
  const sessionId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tot-status-root-'));
    projectDir = mkdtempSync(join(tmpdir(), 'tot-status-proj-'));
    process.env['TOT_DATA_DIR'] = root;
  });
  afterEach(() => {
    if (savedRoot === undefined) delete process.env['TOT_DATA_DIR'];
    else process.env['TOT_DATA_DIR'] = savedRoot;
    for (const d of [root, projectDir]) rmSync(d, { recursive: true, force: true });
  });

  /** Writes a journal for `projectDir`'s store, plus whatever extra lines are given. */
  function journal(...extra: string[]): void {
    const dir = getCentralSessionsDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), [
      line('session-created', { id: sessionId, problem: 'why the build is slow', rootNodeId: 'root', status: 'open', createdAt: ts }),
      line('hypothesis-added', {
        id: 'root', parentId: null, sessionId, depth: 0, title: 'why the build is slow',
        status: 'exploring', evidence: [], children: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' },
      }),
      ...extra,
    ].join(''));
  }

  it('says nothing about a recorded path when the store agrees with the one asked about', () => {
    journal();
    writeProjectMeta(projectDir);
    expect(statusLines(projectDir).join('\n')).not.toContain('recorded for');
  });

  it('says whose trees these are when the store was written for another path', () => {
    // The directory is named by a digest, so two paths can land on one store —
    // and the sessions listed below would then be another project's investigation
    // presented as this project's own.
    journal();
    writeFileSync(
      join(getCentralProjectDir(projectDir), 'meta.json'),
      JSON.stringify({ projectDir: '/home/someone-else/other-project' }),
    );
    const out = statusLines(projectDir).join('\n');
    expect(out).toContain('/home/someone-else/other-project');
    expect(out).toMatch(/not this one/);
  });

  it('lists a session it found, so its id can be read and passed on', () => {
    journal();
    const out = statusLines(projectDir).join('\n');
    expect(out).toContain(sessionId.slice(0, 8));
    expect(out).toContain('why the build is slow');
  });

  it('names the session whose records could not be read, not merely that some were lost', () => {
    // The tree a reader opens is the one that is short. A count with no session
    // attached gives them nothing to act on.
    journal('this line is not json\n');
    expect(statusLines(projectDir).join('\n')).toMatch(/1 unreadable/);
  });

  it('says nothing about unreadable records for a journal that folded whole', () => {
    journal();
    expect(statusLines(projectDir).join('\n')).not.toMatch(/unreadable/);
  });

  it('says a project has no sessions rather than listing none', () => {
    expect(statusLines(projectDir).join('\n')).toContain('No sessions yet');
  });
});
