import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { TOOL_SCHEMAS, getToolHandlers } from '../src/tools.js';
import { TreeManager } from '../src/tree-manager.js';

/**
 * The tool surface is advertised to clients through TOOL_SCHEMAS and executed
 * through the handler map. These are invariants of that surface: the two sides
 * must describe the same set of tools, and every advertised input must document
 * itself, because the schema is the only thing a caller reads before choosing a
 * tool.
 */
describe('tool surface', () => {
  const { handlers } = getToolHandlers(new TreeManager({}), () => '/tmp/tot-surface-test');

  it('advertises exactly the tools that have handlers', () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([...handlers.keys()].sort());
  });

  it('gives every tool a non-empty description', () => {
    for (const [name, def] of Object.entries(TOOL_SCHEMAS)) {
      expect(def.description.trim(), `${name} description`).not.toBe('');
    }
  });

  it('describes every advertised input field', () => {
    // A field with no description reaches the caller as a bare type, which is
    // the most common cause of a tool being called with the wrong argument.
    const undescribed: string[] = [];
    for (const [name, def] of Object.entries(TOOL_SCHEMAS)) {
      for (const [field, schema] of Object.entries(def.schema)) {
        const described = (schema as z.ZodTypeAny).description;
        if (!described || described.trim() === '') undescribed.push(`${name}.${field}`);
      }
    }
    expect(undescribed).toEqual([]);
  });

  it('advertises input shapes that are zod schemas, so listTools can project them', () => {
    for (const [name, def] of Object.entries(TOOL_SCHEMAS)) {
      for (const [field, schema] of Object.entries(def.schema)) {
        expect(schema, `${name}.${field}`).toBeInstanceOf(z.ZodType);
      }
    }
  });

  it('advertises the same constraints the handler enforces for free-text fields', () => {
    // The advertised schema is the contract a caller reads; if it is more
    // permissive than the schema the handler parses with, a caller can satisfy
    // the published contract and still be rejected. Every free-text field the
    // engine requires to be non-blank must therefore reject blank input here too.
    const freeText: Array<[string, string]> = [
      ['create_tree', 'problem'],
      ['add_hypothesis', 'title'],
      ['add_evidence', 'content'],
      ['eliminate_hypothesis', 'reason'],
      ['corroborate_hypothesis', 'reason'],
      ['set_out_of_scope', 'reason'],
    ];
    for (const [tool, field] of freeText) {
      const schema = TOOL_SCHEMAS[tool].schema[field] as z.ZodTypeAny;
      expect(schema.safeParse('   ').success, `${tool}.${field} must reject blank`).toBe(false);
      expect(schema.safeParse('a real value').success, `${tool}.${field} accepts text`).toBe(true);
    }
    // decompose advertises an array of non-blank child titles.
    const children = TOOL_SCHEMAS['decompose'].schema['children'] as z.ZodTypeAny;
    expect(children.safeParse(['ok', '   ']).success, 'decompose.children must reject blank').toBe(false);
    expect(children.safeParse(['ok', 'also ok']).success).toBe(true);
  });
});
