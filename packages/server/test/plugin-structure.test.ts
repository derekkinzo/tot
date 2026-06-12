import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

/** Extract the YAML frontmatter block (between the leading --- fences). */
function frontmatter(content: string): string {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

/**
 * Return the trimmed value for a top-level frontmatter key, supporting both
 * inline (`key: value`) and block-scalar (`key: |` followed by indented
 * lines) forms. Returns '' when the key is absent or its value is empty.
 */
function frontmatterValue(fm: string, key: string): string {
  const lines = fm.split('\n');
  const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (idx === -1) return '';
  const inline = lines[idx].slice(key.length + 1).trim();
  if (inline && inline !== '|' && inline !== '>') return inline;
  // Block scalar: collect subsequent indented lines.
  const block: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\s+\S/.test(lines[i])) block.push(lines[i].trim());
    else if (lines[i].trim() === '') continue;
    else break;
  }
  return block.join(' ').trim();
}

describe('Plugin Structure', () => {
  describe('.claude-plugin/plugin.json', () => {
    it('exists and is valid JSON', () => {
      const path = join(REPO_ROOT, '.claude-plugin/plugin.json');
      expect(existsSync(path)).toBe(true);
      const content = JSON.parse(readFileSync(path, 'utf-8'));
      expect(content.name).toBe('tot-mcp');
      expect(content.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('has non-empty required fields', () => {
      const content = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin/plugin.json'), 'utf-8'));
      // toBeDefined() would pass on "", null, 0 — an empty manifest field is
      // an invalid plugin. Require non-empty strings.
      expect(typeof content.name).toBe('string');
      expect(content.name.length).toBeGreaterThan(0);
      expect(typeof content.description).toBe('string');
      expect(content.description.length).toBeGreaterThan(0);
      expect(typeof content.license).toBe('string');
      expect(content.license.length).toBeGreaterThan(0);
    });
  });

  describe('.mcp.json', () => {
    it('routes the tot MCP server through the persistent data dir', () => {
      const path = join(REPO_ROOT, '.mcp.json');
      expect(existsSync(path)).toBe(true);
      const content = JSON.parse(readFileSync(path, 'utf-8'));
      expect(content.mcpServers?.tot).toEqual({
        command: 'node',
        args: ['${CLAUDE_PLUGIN_DATA}/build/packages/server/dist/cli.js'],
      });
    });
  });

  describe('hooks/install.sh', () => {
    const scriptPath = join(REPO_ROOT, 'hooks/install.sh');

    it('exists and is executable', () => {
      expect(existsSync(scriptPath)).toBe(true);
      const mode = statSync(scriptPath).mode;
      expect((mode & 0o111) !== 0).toBe(true);
    });

    it('is invoked by a SessionStart hook with bash and the plugin-root path', () => {
      const hooks = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks/hooks.json'), 'utf-8'));
      const commands = (hooks.hooks.SessionStart ?? [])
        .flatMap((entry: any) => entry.hooks ?? [])
        .map((h: any) => h.command);
      // A substring match on 'hooks/install.sh' would pass for `cat`/`rm`/a
      // comment or a relative path that breaks under the plugin runtime. The
      // contract is: run it through bash, resolved via ${CLAUDE_PLUGIN_ROOT}.
      expect(commands).toContain('bash "${CLAUDE_PLUGIN_ROOT}/hooks/install.sh"');
    });
  });

  describe('skills/', () => {
    const skillsDir = join(REPO_ROOT, 'skills');
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    it('has at least one skill', () => {
      expect(skills.length).toBeGreaterThan(0);
    });

    for (const skill of skills) {
      describe(`skills/${skill}`, () => {
        it('has SKILL.md', () => {
          expect(existsSync(join(skillsDir, skill, 'SKILL.md'))).toBe(true);
        });

        it('has non-empty name and description frontmatter', () => {
          const content = readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf-8');
          const fm = frontmatter(content);
          expect(fm).not.toBe('');
          // toContain('name:') passes on `# name:` or an empty `name:` — both
          // fail to load. Require an actual non-empty value.
          expect(frontmatterValue(fm, 'name').length).toBeGreaterThan(0);
          expect(frontmatterValue(fm, 'description').length).toBeGreaterThan(0);
        });
      });
    }
  });

  describe('agents/', () => {
    const agentsDir = join(REPO_ROOT, 'agents');
    const agents = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));

    it('has at least one agent', () => {
      expect(agents.length).toBeGreaterThan(0);
    });

    for (const agent of agents) {
      describe(`agents/${agent}`, () => {
        it('has non-empty name, description, model, and color frontmatter', () => {
          const content = readFileSync(join(agentsDir, agent), 'utf-8');
          const fm = frontmatter(content);
          expect(fm).not.toBe('');
          // Require actual values: an empty model id or color breaks agent
          // loading, the exact defect this test claims to guard.
          for (const key of ['name', 'description', 'model', 'color']) {
            expect(frontmatterValue(fm, key).length, `agent ${agent} frontmatter "${key}"`).toBeGreaterThan(0);
          }
        });
      });
    }
  });

  describe('hooks/', () => {
    it('hooks.json exists and is valid', () => {
      const path = join(REPO_ROOT, 'hooks/hooks.json');
      expect(existsSync(path)).toBe(true);
      const content = JSON.parse(readFileSync(path, 'utf-8'));
      expect(content.hooks).toBeDefined();
      expect(typeof content.hooks).toBe('object');
    });

    it('hooks reference valid event names', () => {
      const validEvents = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification'];
      const content = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks/hooks.json'), 'utf-8'));
      for (const event of Object.keys(content.hooks)) {
        expect(validEvents).toContain(event);
      }
    });
  });
});
