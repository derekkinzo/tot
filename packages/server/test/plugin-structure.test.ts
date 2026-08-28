import { describe, it, expect } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { TOOL_SCHEMAS } from '../src/tools.js';
import { buildChallengePrompt, buildInvestigatePrompt, buildReviewDecompositionPrompt } from '../src/prompts.js';
import { TITLE_MAX_LENGTH } from '@tot-mcp/shared';

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

describe('what the guidance tells an agent to call', () => {
  // A skill, agent brief, or the README is the only description of this server an
  // agent reads before calling it. A tool named there that the server does not
  // serve sends the agent to a dead end it cannot diagnose.
  //
  // A backticked token counts as naming a tool when it is called (`x(`), told to
  // be called ("Call `x`"), or shaped like a tool name (snake_case). A bare
  // single word in backticks does not, because an argument name looks the same.
  const NAMED_AS_TOOL = /(?:[Cc]all\s+`([a-z][a-z0-9_]*)`)|`([a-z][a-z0-9_]*)\(|`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

  const toolsNamedIn = (text: string): string[] =>
    [...text.matchAll(NAMED_AS_TOOL)].map((m) => m[1] ?? m[2] ?? m[3]);

  /**
   * The protocol text the MCP prompt hands a client, which is the whole of the
   * guidance for a client that loads no skills — so it is held to the same
   * contract as the shipped markdown.
   */
  const promptText = (): string => [
    buildInvestigatePrompt('why does the nightly export finish with no rows'),
    buildReviewDecompositionPrompt('a-parent-id'),
    buildChallengePrompt('a-hypothesis-id'),
  ].join('\n');

  /** Markdown that ships as guidance: skills, agent briefs, references, README. */
  function guidanceFiles(): string[] {
    const files = [join(REPO_ROOT, 'README.md')];
    for (const [dir, leaf] of [['skills', 'SKILL.md'], ['agents', null], ['references', null]] as const) {
      const base = join(REPO_ROOT, dir);
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        const path = leaf ? join(base, entry, leaf) : join(base, entry);
        if (existsSync(path) && statSync(path).isFile() && path.endsWith('.md')) files.push(path);
      }
    }
    return files;
  }

  it('reads guidance from every shipped markdown file', () => {
    // A scan over an empty file list would pass without checking anything.
    const files = guidanceFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('SKILL.md'))).toBe(true);
  });

  it('names only tools this server serves', () => {
    const served = new Set(Object.keys(TOOL_SCHEMAS));
    const unknown: string[] = [];
    for (const [file, text] of [
      ...guidanceFiles().map((f) => [f, readFileSync(f, 'utf-8')] as const),
      ['the tot-investigate prompt', promptText()] as const,
    ]) {
      for (const name of toolsNamedIn(text)) {
        if (!served.has(name)) unknown.push(`${file.replace(`${REPO_ROOT}/`, '')}: ${name}`);
      }
    }
    expect(unknown, `named as a tool but not served:\n${unknown.join('\n')}`).toEqual([]);
  });


  it('gives a client that loads no skills the whole protocol', () => {
    // A client with no skills and no agent briefs sees only this text. Every tool
    // it would need, and the review step, have to be in it.
    const text = promptText();
    for (const tool of Object.keys(TOOL_SCHEMAS)) {
      expect(text, `the prompt never names ${tool}`).toMatch(new RegExp(`\`${tool}[\`(]`));
    }
  });


  it('offers an independent review a client can run without subagents', () => {
    // A client with no subagent machinery still needs a way to have a structure
    // read by something that did not write it. Both briefs must say so and must
    // name the read surfaces they depend on.
    for (const [name, text] of [
      ['tot-review-decomposition', buildReviewDecompositionPrompt('p1')],
      ['tot-challenge-hypothesis', buildChallengePrompt('h1')],
    ] as const) {
      expect(text, name).toMatch(/`get_tree`/);
      expect(text.length, name).toBeGreaterThan(400);
    }
    // The review states what it cannot settle rather than implying a verdict.
    const review = buildReviewDecompositionPrompt('p1');
    expect(review).toMatch(/never a pass\/fail|cannot be established/i);
    expect(review).toMatch(/another axis/i);
    // The challenge records its proposal in the tree, not only in its reply.
    expect(buildChallengePrompt('h1')).toMatch(/`add_evidence`/);
  });

  it('states the label bound the tools actually enforce', () => {
    // Guidance that names a different number teaches an agent to lose a
    // round-trip on the tree's foundational call.
    const claims: string[] = [];
    for (const file of guidanceFiles()) {
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/(\d+)\s+characters/g)) {
        claims.push(`${file.slice(REPO_ROOT.length + 1)}: ${m[0]}`);
        expect(Number(m[1]), `${file.slice(REPO_ROOT.length + 1)}: "${m[0]}"`).toBe(TITLE_MAX_LENGTH);
      }
    }
    // The bound is stated somewhere, not merely never mis-stated.
    expect(claims.length).toBeGreaterThan(0);
  });

  it('documents every tool it serves somewhere in the guidance', () => {
    // The other direction: a tool no guidance mentions is one an agent has to
    // discover from the schema list alone.
    const guidance = [...guidanceFiles().map((f) => readFileSync(f, 'utf-8')), promptText()].join('\n');
    const undocumented = Object.keys(TOOL_SCHEMAS)
      .filter((tool) => !new RegExp(`\`${tool}[\`(]`).test(guidance));
    expect(undocumented, `served but never named in guidance: ${undocumented.join(', ')}`).toEqual([]);
  });
});

describe('deciding whether the bundled build is stale', () => {
  // The installer rebuilds only when the signature of the sources differs from
  // the one stored beside the last build. A signature blind to a source edit
  // makes an updated plugin keep serving the previous build — including a tool
  // that no longer exists in the sources the user has.
  const SCRIPT = join(REPO_ROOT, 'hooks/source-signature.sh');

  /** A minimal tree shaped like the plugin root: manifests plus one package. */
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'tot-sig-'));
    mkdirSync(join(root, 'packages/a/src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'packages/a/src/x.ts'), 'export const a = 1;\n');
    return root;
  }

  const sign = (root: string): string => execFileSync('bash', [SCRIPT, root], { encoding: 'utf-8' }).trim();

  it('changes when a source file changes', () => {
    const root = fixture();
    try {
      const before = sign(root);
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(root, 'packages/a/src/x.ts'), 'export const a = 2;\n');
      expect(sign(root)).not.toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('changes when a source file is added, renamed, or removed', () => {
    const root = fixture();
    try {
      const before = sign(root);
      writeFileSync(join(root, 'packages/a/src/y.ts'), 'export const b = 1;\n');
      const added = sign(root);
      expect(added).not.toBe(before);
      renameSync(join(root, 'packages/a/src/y.ts'), join(root, 'packages/a/src/z.ts'));
      expect(sign(root)).not.toBe(added);
      rmSync(join(root, 'packages/a/src/z.ts'));
      expect(sign(root)).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('changes when a manifest or the lockfile changes', () => {
    const root = fixture();
    try {
      const before = sign(root);
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      expect(sign(root)).not.toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ignores build outputs and installed dependencies', () => {
    // Otherwise a build invalidates the signature it just wrote and every
    // session rebuilds from scratch.
    const root = fixture();
    try {
      const before = sign(root);
      for (const dir of ['packages/a/dist', 'packages/a/static', 'packages/a/node_modules/dep']) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'out.js'), 'whatever');
      }
      expect(sign(root)).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails rather than printing a signature it could not compute', () => {
    // A blank or bogus signature would compare unequal every time (endless
    // rebuilds) or equal by accident (a stale build served forever).
    const root = fixture();
    try {
      rmSync(join(root, 'package-lock.json'));
      expect(() => sign(root)).toThrow();
      expect(() => execFileSync('bash', [SCRIPT, join(root, 'nope')], { encoding: 'utf-8' })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ships as an executable the installer can run', () => {
    // The installer refuses to build when it cannot sign the sources, so a
    // missing or non-executable script leaves the MCP server unbuilt.
    expect(existsSync(SCRIPT)).toBe(true);
    expect((statSync(SCRIPT).mode & 0o111) !== 0).toBe(true);
    const installer = readFileSync(join(REPO_ROOT, 'hooks/install.sh'), 'utf-8');
    expect(installer).toContain('source-signature.sh');
  });
});
