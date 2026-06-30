/**
 * Access-label exclusion policy for the search index-build path.
 *
 * Implements kbexplorer issue #9 (E5-A3): the committed search index respects
 * access labels so access-restricted resources do not leak via search.
 *
 * Design invariants:
 *  - kbx **labels**, the host **enforces**. This module performs **zero**
 *    principal evaluation — it only decides, from a resource's static label
 *    plus static config, whether a unit belongs in the committed index.
 *  - Exclusion is a **pure function** of (label, config). No timestamps, no
 *    randomness, no I/O. Same graph + same config => byte-identical artifacts,
 *    so the deterministic drift gate stays green.
 *  - Default-SAFE: restricted/unknown classification and `private` visibility
 *    are excluded from the committed index unless explicitly opted into the
 *    host-predicate filtered (`include`) mode.
 */

import type {
  KBAccessLabel,
  KBAccessClassification,
  KBAccessVisibility,
} from './kbexplorer-types.js';

/**
 * Classification severity lattice (higher = more sensitive).
 *
 * `unknown > restricted > confidential > internal > public > absent`.
 * `absent` (no classification supplied) is the least sensitive rung so that
 * unlabeled, ordinary content is indexed; an explicit `unknown` is the most
 * sensitive because an unclassified-but-present marker may hide anything.
 */
export const CLASSIFICATION_SEVERITY: Record<KBAccessClassification, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
  unknown: 5,
};

/** Severity used when a label omits `classification` entirely (`absent`). */
export const ABSENT_CLASSIFICATION_SEVERITY = 0;

/**
 * How access-restricted units are treated during index build.
 *
 *  - `exclude` (default, SAFE): excluded units produce no SearchUnit and no
 *    vector — they never reach units.json/vectors.json, so titles can't leak.
 *  - `include`: the host-predicate filtered mode. Restricted units ARE indexed
 *    but each carries its `access` label so a host can filter at query time.
 *    Search still performs no principal evaluation.
 */
export type AccessExclusionMode = 'exclude' | 'include';

/** Configuration for access-label-driven index exclusion. */
export interface AccessExclusionConfig {
  /** Index-build treatment of restricted units. Default: `exclude`. */
  mode: AccessExclusionMode;
  /** Classifications excluded from the committed index. */
  excludedClassifications: KBAccessClassification[];
  /** Visibilities excluded from the committed index. */
  excludedVisibilities: KBAccessVisibility[];
}

/**
 * Default-SAFE exclusion policy: withhold restricted/unknown classification and
 * `private` visibility from the committed index.
 */
export const DEFAULT_ACCESS_EXCLUSION: AccessExclusionConfig = {
  mode: 'exclude',
  excludedClassifications: ['restricted', 'unknown'],
  excludedVisibilities: ['private'],
};

/**
 * Resolve a partial config into a fully-populated one, applying SAFE defaults
 * for any omitted field. Pure; never mutates the input.
 */
export function resolveAccessConfig(
  config?: Partial<AccessExclusionConfig>,
): AccessExclusionConfig {
  return {
    mode: config?.mode ?? DEFAULT_ACCESS_EXCLUSION.mode,
    excludedClassifications:
      config?.excludedClassifications ??
      DEFAULT_ACCESS_EXCLUSION.excludedClassifications,
    excludedVisibilities:
      config?.excludedVisibilities ??
      DEFAULT_ACCESS_EXCLUSION.excludedVisibilities,
  };
}

/**
 * Severity of a label's classification on the access lattice. Returns
 * {@link ABSENT_CLASSIFICATION_SEVERITY} when no classification is present.
 */
export function classificationSeverity(label?: KBAccessLabel): number {
  const classification = label?.classification;
  if (!classification) return ABSENT_CLASSIFICATION_SEVERITY;
  return CLASSIFICATION_SEVERITY[classification] ?? ABSENT_CLASSIFICATION_SEVERITY;
}

/**
 * Decide whether a resource carrying `label` is excluded from the committed
 * index under `config`.
 *
 * Pure function of (label, config). A resource is excluded when EITHER its
 * classification OR its visibility falls in the configured excluded sets. A
 * missing label (or empty label) is never excluded — unlabeled content is
 * indexed as ordinary.
 */
export function isExcludedByAccess(
  label: KBAccessLabel | undefined,
  config: AccessExclusionConfig,
): boolean {
  if (!label) return false;
  if (
    label.classification &&
    config.excludedClassifications.includes(label.classification)
  ) {
    return true;
  }
  if (label.visibility && config.excludedVisibilities.includes(label.visibility)) {
    return true;
  }
  return false;
}
