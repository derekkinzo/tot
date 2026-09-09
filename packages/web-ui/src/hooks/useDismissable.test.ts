import { describe, it, expect } from 'vitest';
import { keyDismisses, pressDismisses } from './useDismissable';

describe('what dismisses an open menu', () => {
  // The canvas binds single-letter and arrow shortcuts at the document. A menu
  // that took more than Escape would swallow them while it is open, and one that
  // dismissed on a press anywhere would close on the press that opened it.

  it('closes on Escape', () => {
    expect(keyDismisses('Escape')).toBe(true);
  });

  it('closes on nothing else, including the keys the canvas reads', () => {
    for (const key of ['Enter', 'Tab', ' ', 'f', 'F', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Esc', 'escape', '']) {
      expect(keyDismisses(key), key).toBe(false);
    }
  });

  it('closes on a press outside its boundary', () => {
    expect(pressDismisses(false)).toBe(true);
  });

  it('leaves a press inside its boundary alone, so the trigger can toggle it', () => {
    // The boundary encloses the trigger. Dismissing on a press there as well would
    // close the menu and let the trigger re-open it in the same gesture.
    expect(pressDismisses(true)).toBe(false);
  });
});
