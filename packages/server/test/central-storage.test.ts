import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { hashProjectDir, getCentralProjectDir, getCentralSessionsDir } from '../src/central-storage.js';
import { getTotDir } from '../src/storage-paths.js';

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
