/**
 * Which layer a key press belongs to.
 *
 * The canvas binds single-letter and arrow shortcuts at the document, so every
 * other layer that reads keys — a text field, an overlay showing a captured log —
 * would otherwise act twice: one press both scrolling the log and moving the
 * selection behind it. One rule, consulted by every document-level handler,
 * keeps that ownership in a single place.
 */

/** The parts of an event target that decide ownership. Structural rather than a
 *  DOM instance check, so the rule holds for any element that accepts typing and
 *  is testable without a document. */
export interface KeyTarget {
  tagName?: string | undefined;
  isContentEditable?: boolean | undefined;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True when the press is going into a field the user is typing in. */
export function isTypingTarget(target: KeyTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  return TYPING_TAGS.has((target.tagName ?? '').toUpperCase());
}

export interface KeyContext {
  /** Layers stacked above the canvas that are reading keys. */
  overlays: number;
  target?: KeyTarget | null;
}

/**
 * Whether a canvas-level shortcut may act on this press.
 *
 * False while anything above the canvas owns the keyboard, so an overlay does not
 * have to know which shortcuts exist in order to avoid them.
 */
export function canvasOwnsKey(ctx: KeyContext): boolean {
  if (ctx.overlays > 0) return false;
  return !isTypingTarget(ctx.target);
}
