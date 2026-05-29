import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

describe('Plugin Structure', () => {
  describe('.claude-plugin/plugin.json', () => {
    it('exists and is valid JSON', () => {
      const path = join(REPO_ROOT, '.claude-plugin/plugin.json');
      expect(existsSync(path)).toBe(true);
      const content = JSON.parse(readFileSync(path, 'utf-8'));
      expect(content.name).toBe('tot-mcp');
      expect(content.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('has required fields', () => {
      const content = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin/plugin.json'), 'utf-8'));
      expect(content.name).toBeDefined();
      expect(content.description).toBeDefined();
      expect(content.license).toBeDefined();
    });
  });

  describe('.mcp.json', () => {
    it('exists and references tot-mcp', () => {
      const path = join(REPO_ROOT, '.mcp.json');
      expect(existsSync(path)).toBe(true);
      const content = JSON.parse(readFileSync(path, 'utf-8'));
      expect(content.tot).toBeDefined();
      expect(content.tot.command).toBe('npx');
      expect(content.tot.args).toContain('tot-mcp');
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

        it('has valid frontmatter with name and description', () => {
          const content = readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf-8');
          const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
          expect(frontmatter).not.toBeNull();
          expect(frontmatter![1]).toContain('name:');
          expect(frontmatter![1]).toContain('description:');
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
        it('has valid frontmatter with name, description, model, and color', () => {
          const content = readFileSync(join(agentsDir, agent), 'utf-8');
          const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
          expect(frontmatter).not.toBeNull();
          expect(frontmatter![1]).toContain('name:');
          expect(frontmatter![1]).toContain('description:');
          expect(frontmatter![1]).toContain('model:');
          expect(frontmatter![1]).toContain('color:');
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
