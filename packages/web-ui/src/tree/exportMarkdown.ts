import type { Hypothesis, Session } from '../types';
import { countSupporting, countRefuting } from '../types';
import { STATUS_NODE_STYLES } from '../theme';
import { conclusionStatus } from './conclusion';

/**
 * Renders a session's hypothesis tree as a Markdown report. Pure and
 * dependency-free so it is unit-testable and reusable outside the React tree.
 *
 * The recursive walk is cycle-guarded (a `seen` set), matching every other tree
 * traversal in the codebase: a corrupt or hand-edited journal can produce a
 * children cycle, which would otherwise overflow the stack in the browser.
 */
export function generateMarkdown(session: Session, hypotheses: Map<string, Hypothesis>): string {
  const lines: string[] = [];
  lines.push(`# ${session.problem}`);
  lines.push('');
  lines.push(`Status: ${session.status} | Created: ${new Date(session.createdAt).toLocaleString()}`);
  lines.push('');
  lines.push('## Hypothesis Tree');
  lines.push('');

  const root = hypotheses.get(session.rootNodeId);
  if (root) {
    renderNode(root, hypotheses, lines, 0, new Set<string>());
  }

  return lines.join('\n');
}

function renderNode(
  node: Hypothesis,
  hypotheses: Map<string, Hypothesis>,
  lines: string[],
  depth: number,
  seen: Set<string>,
): void {
  // Guard against a children cycle from a corrupt journal so the walk
  // terminates instead of recursing forever.
  if (seen.has(node.id)) return;
  seen.add(node.id);

  const indent = '  '.repeat(depth);
  const icon = STATUS_NODE_STYLES[node.status]?.icon ?? '?';
  const ev = node.evidence.length > 0
    ? ` (${countSupporting(node)} supporting, ${countRefuting(node)} refuting)`
    : '';

  lines.push(`${indent}- ${icon} **${node.content}**${ev} [${node.status}]`);

  const concl = conclusionStatus(node);
  if (concl) {
    const prefix = !concl.isHistorical
      ? concl.verdict
      : concl.supersededByDescendant
        ? `historically ${concl.verdict} (reopened by refuted descendant)`
        : `historically ${concl.verdict}`;
    lines.push(`${indent}  > ${prefix}: ${node.conclusion!.reason}`);
  }

  for (const ev of node.evidence) {
    lines.push(`${indent}  - _${ev.type}_: ${ev.content}${ev.source ? ` (${ev.source})` : ''}`);
  }

  for (const childId of node.children) {
    const child = hypotheses.get(childId);
    if (child) renderNode(child, hypotheses, lines, depth + 1, seen);
  }
}
