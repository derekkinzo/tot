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

  it('advertises the same constraints the handler enforces for text fields', () => {
    // The advertised schema is the contract a caller reads; if it is more
    // permissive than the schema the handler parses with, a caller can satisfy
    // the published contract and still be rejected.
    //
    // The set is derived from the schemas rather than listed, so a field added
    // later is covered without anyone remembering to add it here: any field that
    // accepts text at all must refuse text that is only whitespace, directly or
    // inside an array. Optional fields included — omitting one is how a caller
    // says nothing, so an explicit blank is never the way to say it, and
    // exempting them is what let an identifier-shaped field keep accepting it.
    const PROSE = 'a real value';
    const BLANK = '   ';
    const offenders: string[] = [];
    let checked = 0;

    for (const [name, def] of Object.entries(TOOL_SCHEMAS)) {
      for (const [field, raw] of Object.entries(def.schema)) {
        const schema = raw as z.ZodTypeAny;
        const takesText = schema.safeParse(PROSE).success;
        const takesTextList = schema.safeParse([PROSE]).success;
        if (!takesText && !takesTextList) continue;
        checked++;
        const blank = takesText ? BLANK : [BLANK];
        if (schema.safeParse(blank).success) offenders.push(`${name}.${field}`);
      }
    }

    // A rule that matched nothing would pass vacuously.
    expect(checked).toBeGreaterThan(5);
    expect(offenders, `these advertised fields accept whitespace-only input:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('covers the axis a decomposition declares, which the engine requires non-blank', () => {
    // Named because it is the field most recently added to the surface and the
    // one a caller is most likely to pass as an empty placeholder.
    const axis = TOOL_SCHEMAS['decompose'].schema['axis'] as z.ZodTypeAny;
    expect(axis.safeParse('   ').success).toBe(false);
    expect(axis.safeParse('by subsystem').success).toBe(true);
  });

});
