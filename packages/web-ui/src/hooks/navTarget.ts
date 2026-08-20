import type { Hypothesis } from '../types';

/**
 * Resolves an arrow key to the hypothesis it should move the selection to, or
 * null when the key is unhandled or the move has no destination. Pure, so the
 * traversal rules are unit-testable independently of the canvas.
 *
 * Guarantees the caller relies on: the returned id is always present in
 * `hypotheses`. A dangling parent reference or an absent selection yields null
 * rather than a target that cannot be rendered or inspected.
 */
export function nextNavTarget(
  key: string,
  selectedId: string | null,
  hypotheses: Map<string, Hypothesis>,
): string | null {
  if (!selectedId) return null;
  const current = hypotheses.get(selectedId);
  if (!current) return null;

  const resolve = (id: string | null | undefined): string | null =>
    id && hypotheses.has(id) ? id : null;

  switch (key) {
    case 'ArrowUp':
      return resolve(current.parentId);
    case 'ArrowDown':
      return resolve(current.children[0]);
    case 'ArrowLeft':
    case 'ArrowRight': {
      const parent = current.parentId ? hypotheses.get(current.parentId) : undefined;
      if (!parent) return null;
      const index = parent.children.indexOf(selectedId);
      if (index < 0) return null;
      return resolve(parent.children[index + (key === 'ArrowLeft' ? -1 : 1)]);
    }
    default:
      return null;
  }
}
