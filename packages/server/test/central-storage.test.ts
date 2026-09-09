import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hashProjectDir, getCentralProjectDir, getCentralSessionsDir, readProjectMeta, writeProjectMeta } from '../src/central-storage.js';
import { ensureStoreDir, getTotDir } from '../src/storage-paths.js';

const savedEnv = { ...process.env };
afterEach(() => {
  // Restore env keys this suite mutates.
  for (const k of ['TOT_DATA_DIR', 'XDG_STATE_HOME', 'HOME']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('central-storage', () => {
  it('hashProjectDir returns a 16-hex-char prefix of sha256(resolve(dir)) — derived from the spec', () => {
    const dir = '/home/alice/projects/widget';
    const expected = createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 16);
    expect(hashProjectDir(dir)).toBe(expected);
    expect(hashProjectDir(dir)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashProjectDir is deterministic and normalizes path form (resolve, not symlink)', () => {
    const base = '/home/alice/projects/widget';
    // resolve() normalizes ./ and trailing segments to the same absolute path.
    expect(hashProjectDir(base)).toBe(hashProjectDir(base + '/.'));
    expect(hashProjectDir(base)).toBe(hashProjectDir(base + '/sub/..'));
    // Different paths produce different hashes.
    expect(hashProjectDir(base)).not.toBe(hashProjectDir(base + '-other'));
  });

  it('getCentralSessionsDir composes <totDir>/projects/<hash>/sessions', () => {
    delete process.env['TOT_DATA_DIR'];
    delete process.env['XDG_STATE_HOME'];
    process.env['HOME'] = '/home/alice';
    const dir = '/home/alice/projects/widget';
    const hash = hashProjectDir(dir);
    expect(getCentralProjectDir(dir)).toBe(join('/home/alice/.tot', 'projects', hash));
    expect(getCentralSessionsDir(dir)).toBe(join('/home/alice/.tot', 'projects', hash, 'sessions'));
  });

  it('honors TOT_DATA_DIR as the storage root (highest precedence)', () => {
    process.env['TOT_DATA_DIR'] = '/custom/state';
    process.env['XDG_STATE_HOME'] = '/xdg/state';
    process.env['HOME'] = '/home/alice';
    expect(getTotDir()).toBe('/custom/state');
    const dir = '/home/alice/projects/widget';
    expect(getCentralSessionsDir(dir)).toBe(join('/custom/state', 'projects', hashProjectDir(dir), 'sessions'));
  });

  it('getTotDir precedence is TOT_DATA_DIR > XDG_STATE_HOME > ~/.tot', () => {
    process.env['HOME'] = '/home/alice';
    delete process.env['TOT_DATA_DIR'];
    delete process.env['XDG_STATE_HOME'];
    expect(getTotDir()).toBe('/home/alice/.tot');

    process.env['XDG_STATE_HOME'] = '/xdg/state';
    expect(getTotDir()).toBe(join('/xdg/state', 'tot'));

    process.env['TOT_DATA_DIR'] = '/custom/state';
    expect(getTotDir()).toBe('/custom/state');
  });
});

describe('writeProjectMeta', () => {
  let root: string;
  const savedEnv = { ...process.env };

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (savedEnv['TOT_DATA_DIR'] === undefined) delete process.env['TOT_DATA_DIR'];
    else process.env['TOT_DATA_DIR'] = savedEnv['TOT_DATA_DIR'];
  });

  it('writes meta.json recording the resolved project path', () => {
    root = mkdtempSync(join(tmpdir(), 'tot-meta-'));
    process.env['TOT_DATA_DIR'] = root;
    const project = '/home/alice/widget';
    writeProjectMeta(project);
    const meta = JSON.parse(readFileSync(join(getCentralProjectDir(project), 'meta.json'), 'utf-8'));
    expect(meta.projectDir).toBe(resolve(project));
  });

  it('rewrites a meta.json whose JSON parses to a non-object instead of crashing', () => {
    root = mkdtempSync(join(tmpdir(), 'tot-meta-'));
    process.env['TOT_DATA_DIR'] = root;
    const project = '/home/alice/widget';
    const dir = getCentralProjectDir(project);
    mkdirSync(dir, { recursive: true });
    // A bare JSON primitive: parses without throwing but has no .projectDir.
    writeFileSync(join(dir, 'meta.json'), 'null');

    expect(() => writeProjectMeta(project)).not.toThrow();
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
    expect(meta.projectDir).toBe(resolve(project));
  });

  it('is idempotent: a second call with an unchanged path leaves meta.json intact', () => {
    root = mkdtempSync(join(tmpdir(), 'tot-meta-'));
    process.env['TOT_DATA_DIR'] = root;
    const project = '/home/alice/widget';
    writeProjectMeta(project);
    const path = join(getCentralProjectDir(project), 'meta.json');
    const first = readFileSync(path, 'utf-8');
    writeProjectMeta(project);
    expect(readFileSync(path, 'utf-8')).toBe(first);
  });
});

describe('readProjectMeta', () => {
  // The store directory is named by a digest, so the name cannot be read back
  // into a path. meta.json is the only account of which project the trees inside
  // belong to, and two paths can hash to one directory.

  let root: string;
  const project = '/home/alice/widget';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tot-meta-read-'));
    process.env['TOT_DATA_DIR'] = root;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads back the path the store was written for', () => {
    writeProjectMeta(project);
    expect(readProjectMeta(project)).toBe(resolve(project));
  });

  it('reports no recorded path when the store holds no meta.json', () => {
    expect(readProjectMeta(project)).toBeUndefined();
  });

  it('reports no recorded path when meta.json is unreadable or names none', () => {
    // Absent, corrupt, and describing something that is not a path all say the
    // same thing to a caller: this store does not name its project. Handing back
    // whatever the file held would have a caller compare a real path against a
    // number, and report a mismatch nobody can act on.
    const dir = getCentralProjectDir(project);
    mkdirSync(dir, { recursive: true });
    for (const body of ['not json at all', 'null', '{}', '{"projectDir":""}', '{"projectDir":42}']) {
      writeFileSync(join(dir, 'meta.json'), body);
      expect(readProjectMeta(project), body).toBeUndefined();
    }
  });
});

describe('ensureStoreDir', () => {
  // A stored tree holds whatever the investigation looked at, captured verbatim
  // from the machine it ran on. The store's path is derivable rather than secret,
  // so a default-mode directory is readable by every account on the host in
  // practice and not merely in principle.

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tot-mode-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const mode = (dir: string) => statSync(dir).mode & 0o777;

  it('creates a directory only its owner can read', () => {
    const dir = join(root, 'projects', 'abc', 'sessions');
    ensureStoreDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it('closes every parent it creates on the way, not only the leaf', () => {
    // An open parent is enough: its children are listable, and a name reached by
    // hashing a project path is the whole of what guards it.
    ensureStoreDir(join(root, 'projects', 'abc', 'sessions'));
    expect(mode(join(root, 'projects'))).toBe(0o700);
    expect(mode(join(root, 'projects', 'abc'))).toBe(0o700);
  });

  it('leaves an existing directory the mode its owner gave it', () => {
    // A user who widened it did so deliberately; re-tightening on every startup
    // would silently undo that.
    const dir = join(root, 'shared');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensureStoreDir(dir);
    expect(mode(dir)).toBe(0o755);
  });
});
