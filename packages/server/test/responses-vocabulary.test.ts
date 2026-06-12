import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RESPONSES_PATH = resolve(__dirname, '..', 'src', 'responses.ts');

const BANNED_TOKENS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsubagents?\b/i, reason: 'client-specific (Claude Code subagent dispatch)' },
  { pattern: /\bfan out\b/i, reason: 'client-specific (Claude Code subagent dispatch)' },
  { pattern: /\bclaude code\b/i, reason: 'client-specific brand name' },
  { pattern: /\/tot-[a-z]+/i, reason: 'slash command — only meaningful inside Claude Code' },
];

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|\*\/)/;

describe('responses.ts cross-client vocabulary', () => {
  const source = readFileSync(RESPONSES_PATH, 'utf-8');
  const lines = source.split('\n');

  for (const { pattern, reason } of BANNED_TOKENS) {
    it(`forbids ${pattern} in tool-response strings (${reason})`, () => {
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (COMMENT_LINE.test(line)) continue;
        if (pattern.test(line)) {
          offenders.push(`${i + 1}: ${line.trim()}`);
        }
      }
      expect(offenders, `Banned token in cross-client tool responses:\n${offenders.join('\n')}`).toHaveLength(0);
    });
  }
});
