import type { Hypothesis } from './types.js';

/**
 * Returns true when the subtree rooted at id contains a corroborated node
 * reachable through non-pruned ancestors. Pruned subtrees (eliminated or
 * out-of-scope) are not descended — descendants of a pruned branch are
 * moot under the same rule the closure walker applies.
 *
 * Caller supplies a lookup callback so this walker is independent of the
 * underlying storage. The engine passes a Map.get bound to its in-memory
 * hypothesis table; replay paths bind the same against a per-session Map
 * built from journal entries.
 */
export function subtreeContainsCorroborated(
  rootId: string,
  lookup: (id: string) => Hypothesis | undefined,
): boolean {
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = lookup(id);
    if (!node) continue;
    if (node.status === 'eliminated' || node.status === 'out-of-scope') continue;
    if (node.status === 'corroborated') return true;
    for (const childId of node.children) stack.push(childId);
  }
  return false;
}
