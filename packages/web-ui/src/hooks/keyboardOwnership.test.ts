import { describe, it, expect } from 'vitest';
import { canvasOwnsKey, isTypingTarget } from './keyboardOwnership';

describe('isTypingTarget', () => {
  it('claims the fields a user types into', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTypingTarget({ tagName })).toBe(true);
    }
  });

  it('claims an editable element whatever its tag', () => {
    // Ownership follows what the element does, not which class it happens to be.
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('matches a tag name case-insensitively, as a serialized name may arrive', () => {
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
  });

  it('leaves ordinary elements and a missing target to the canvas', () => {
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
});

describe('canvasOwnsKey', () => {
  it('lets the canvas act when nothing is stacked above it', () => {
    expect(canvasOwnsKey({ overlays: 0, target: { tagName: 'DIV' } })).toBe(true);
  });

  it('stands down while an overlay is open, whatever the press', () => {
    // An overlay showing a captured log must not also move the selection behind
    // it, and must not have to enumerate the canvas shortcuts to prevent that.
    expect(canvasOwnsKey({ overlays: 1, target: { tagName: 'DIV' } })).toBe(false);
  });

  it('stands down for typing even with no overlay open', () => {
    expect(canvasOwnsKey({ overlays: 0, target: { tagName: 'INPUT' } })).toBe(false);
  });

  it('stays stood down while any overlay remains stacked', () => {
    expect(canvasOwnsKey({ overlays: 2, target: null })).toBe(false);
  });
});
