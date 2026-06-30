import { isStrictAncestorScope, scopeAncestors, scopeLabel, scopeParent } from "@/lib/rbac";
import type { SubjectBinding } from "./types";

/** A grant cascading into a node from an ancestor scope. */
export interface InheritedGrant {
  binding: SubjectBinding;
  fromScope: string;
  fromLabel: string;
}

/** One scope in the hierarchy, with the grants resolved at it. */
export interface ScopeTreeNode {
  scope: string;
  label: string;
  depth: number;
  /** Grants assigned directly on this scope. */
  direct: SubjectBinding[];
  /** Grants inherited from an ancestor scope (Azure-style cascade). */
  inherited: InheritedGrant[];
  children: ScopeTreeNode[];
}

/** scopeAncestors returns the normalized scope as its first (most-specific) entry. */
function normalizedScope(scope: string): string {
  return scopeAncestors(scope)[0];
}

/**
 * Builds the scope hierarchy implied by a subject's bindings. Every binding's
 * scope and all of its ancestors become nodes, so the tree is connected up to
 * the platform root. Each node separates grants assigned DIRECTLY on it from
 * grants INHERITED from an ancestor scope, letting the visualizer show how a
 * parent assignment cascades downward.
 */
export function buildScopeTree(bindings: SubjectBinding[]): ScopeTreeNode[] {
  if (bindings.length === 0) return [];

  const scopes = new Set<string>();
  for (const binding of bindings) {
    for (const ancestor of scopeAncestors(binding.scope)) scopes.add(ancestor);
  }

  const nodes = new Map<string, ScopeTreeNode>();
  for (const scope of scopes) {
    nodes.set(scope, { scope, label: scopeLabel(scope), depth: 0, direct: [], inherited: [], children: [] });
  }

  for (const binding of bindings) {
    const bindingScope = normalizedScope(binding.scope);
    for (const node of nodes.values()) {
      if (node.scope === bindingScope) {
        node.direct.push(binding);
      } else if (isStrictAncestorScope(binding.scope, node.scope)) {
        node.inherited.push({ binding, fromScope: bindingScope, fromLabel: scopeLabel(binding.scope) });
      }
    }
  }

  // Link each node to its nearest present ancestor; nodes with none are roots.
  const roots: ScopeTreeNode[] = [];
  for (const node of nodes.values()) {
    let parentScope = scopeParent(node.scope);
    while (parentScope && !nodes.has(parentScope)) parentScope = scopeParent(parentScope);
    const parent = parentScope ? nodes.get(parentScope) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const assignDepth = (node: ScopeTreeNode, depth: number): void => {
    node.depth = depth;
    node.children.sort((a, b) => a.label.localeCompare(b.label));
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  roots.sort((a, b) => a.label.localeCompare(b.label));
  for (const root of roots) assignDepth(root, 0);

  return roots;
}

/** Flattens the tree depth-first for simple list rendering. */
export function flattenScopeTree(roots: ScopeTreeNode[]): ScopeTreeNode[] {
  const out: ScopeTreeNode[] = [];
  const walk = (node: ScopeTreeNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}
