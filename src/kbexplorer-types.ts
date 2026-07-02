/**
 * Thin re-export of the canonical kbexplorer graph/access contracts from
 * `@anokye-labs/kbexplorer-core` (issue #7).
 *
 * This module used to carry a hand-mirrored copy of core's types. That mirror
 * has been retired in favor of importing the real thing so the two surfaces
 * can never drift (issue #17) — in particular `KBAccessLabel`, which is now
 * re-exported byte-for-byte from core instead of a hand-copied shape.
 *
 * The module is kept (rather than having every import site reach into
 * `@anokye-labs/kbexplorer-core` directly) purely so existing import paths in
 * this package don't churn. `KBAccessClassification` / `KBAccessVisibility`
 * are local aliases for core's `AccessClassification` / `AccessVisibility` —
 * the "KB"-prefixed names predate core's extraction and are kept here for the
 * same reason.
 */

export type {
  EdgeType,
  EdgeSource,
  Connection,
  NodeSource,
  JsonLd,
  KBNode,
  KBEdge,
  Cluster,
  KBGraph,
  KBAccessLabel,
  ExternalRef,
} from '@anokye-labs/kbexplorer-core';

export type {
  AccessClassification as KBAccessClassification,
  AccessVisibility as KBAccessVisibility,
} from '@anokye-labs/kbexplorer-core';
