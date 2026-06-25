import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateLegacySessions } from '../src/legacy-migration.js';
import { getCentralSessionsDir } from '../src/central-storage.js';

describe('legacy-migration', () => {
  let tmp: string;       // stands in for a project dir
  let totRoot: string;   // stands in for ~/.tot (via TOT_DATA_DIR)
  const saved = process.env['TOT_DATA_DIR'];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tot-proj-'));
    totRoot = mkdtempSync(join(tmpdir(), 'tot-root-'));
    process.env['TOT_DATA_DIR'] = totRoot;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(totRoot, { recursive: true, force: true });
    if (saved === undefined) delete process.env['TOT_DATA_DIR'];
    else process.env['TOT_DATA_DIR'] = saved;
  });

  function seedLegacy(name: string, content: string): void {
    const legacyDir = join(tmp, '.tot', 'sessions');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, name), content);
  }

  it('copies every legacy .tot/sessions/*.jsonl into the central dir byte-for-byte', () => {
    seedLegacy('a.jsonl', '{"type":"session-created"}\n');
    seedLegacy('b.jsonl', '{"type":"hypothesis-added"}\n');
    migrateLegacySessions(tmp);
    const central = getCentralSessionsDir(tmp);
    expect(readFileSync(join(central, 'a.jsonl'), 'utf-8')).toBe('{"type":"session-created"}\n');
    expect(readFileSync(join(central, 'b.jsonl'), 'utf-8')).toBe('{"type":"hypothesis-added"}\n');
  });

  it('is non-destructive: legacy files remain with original bytes after migration', () => {
    seedLegacy('a.jsonl', 'ORIGINAL\n');
    migrateLegacySessions(tmp);
    expect(existsSync(join(tmp, '.tot', 'sessions', 'a.jsonl'))).toBe(true);
    expect(readFileSync(join(tmp, '.tot', 'sessions', 'a.jsonl'), 'utf-8')).toBe('ORIGINAL\n');
  });

  it('is idempotent and never clobbers a diverged central file', () => {
    seedLegacy('a.jsonl', 'LEGACY\n');
    migrateLegacySessions(tmp);
    // Simulate the central copy having advanced past the legacy snapshot.
    const central = getCentralSessionsDir(tmp);
    writeFileSync(join(central, 'a.jsonl'), 'CENTRAL-ADVANCED\n');
    migrateLegacySessions(tmp); // second run must not overwrite
    expect(readFileSync(join(central, 'a.jsonl'), 'utf-8')).toBe('CENTRAL-ADVANCED\n');
  });

  it('copies atomically with exclusive create, so a concurrently-created central file is never clobbered', () => {
    // The guard against clobbering a diverged central file must not depend on a
    // racy existsSync check: a second server (the plugin reconnect race) can
    // create the central file between this process's check and copy. Exclusive
    // create (COPYFILE_EXCL) makes the copy fail closed rather than overwrite.
    // Here the central file already exists with diverged content and the legacy
    // file is present; migration must leave the central content intact and not
    // throw.
    seedLegacy('race.jsonl', 'LEGACY\n');
    const central = getCentralSessionsDir(tmp);
    mkdirSync(central, { recursive: true });
    writeFileSync(join(central, 'race.jsonl'), 'CENTRAL-WINS\n');

    expect(() => migrateLegacySessions(tmp)).not.toThrow();
    expect(readFileSync(join(central, 'race.jsonl'), 'utf-8')).toBe('CENTRAL-WINS\n');
  });

  it('is a no-op when no legacy .tot/ dir exists (no throw, no spurious central files)', () => {
    expect(() => migrateLegacySessions(tmp)).not.toThrow();
    const central = getCentralSessionsDir(tmp);
    // Either the dir does not exist or it is empty — never populated from nothing.
    if (existsSync(central)) {
      const { readdirSync } = require('node:fs');
      expect(readdirSync(central).filter((f: string) => f.endsWith('.jsonl'))).toHaveLength(0);
    }
  });
});
