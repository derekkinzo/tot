import { useEffect, useRef } from 'react';

/**
 * Whether a key press dismisses an open menu.
 *
 * Escape and nothing else: every other key belongs to whatever is beneath, and a
 * menu that swallowed more would take the canvas's own shortcuts with it.
 */
export function keyDismisses(key: string): boolean {
  return key === 'Escape';
}

/**
 * Whether a press dismisses an open menu, given where it landed.
 *
 * A press on the trigger counts as inside, so the trigger's own handler does the
 * closing — dismissing here as well would close and re-open in one gesture.
 */
export function pressDismisses(insideBoundary: boolean): boolean {
  return !insideBoundary;
}

/**
 * Dismisses an open menu on Escape or on a press outside it, and returns the ref
 * to put on the element that encloses both the trigger and the menu.
 *
 * Every other layer over the canvas closes this way, so a menu that only closes
 * by clicking its own trigger again is a dead end for anyone who reached for
 * Escape — and while it is open it covers the controls beside it.
 *
 * Escape is taken in the capture phase and stopped there. The canvas binds
 * Escape at the document to clear its selection; letting the press through would
 * close this menu and clear the selection behind it with one key.
 *
 * The ref encloses the trigger, so a press on the trigger counts as inside and
 * the trigger's own handler does the closing — otherwise a click on it would
 * dismiss and re-open in one gesture.
 */
export function useDismissable<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onDismiss: () => void,
) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!keyDismisses(e.key)) return;
      e.stopPropagation();
      onDismiss();
    };
    // mousedown rather than click: the press is what the reader means as "away
    // from this", and a menu item's own click must still reach it.
    const onPointerDown = (e: MouseEvent) => {
      const el = ref.current;
      const inside = !!el && e.target instanceof Node && el.contains(e.target);
      if (pressDismisses(inside)) onDismiss();
    };

    // Both in the capture phase, so the press is seen on the way down. The canvas
    // pan gesture claims a press on the tree and stops it reaching anything else,
    // and that press — going back to the tree — is the plainest "away from this"
    // there is; a listener waiting for it to bubble would never hear it.
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [open, onDismiss]);

  return ref;
}
