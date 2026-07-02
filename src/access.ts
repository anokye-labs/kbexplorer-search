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
 *  - Default-SAFE and FAIL-CLOSED: the only classifications indexed are the
 *    explicitly-known open tiers (`public`/`internal`); the only visibilities
 *    indexed are `public`/`internal`. `KBAccessClassification` /
 *    `KBAccessVisibility` are OPEN unions, so any *bespoke* token a host mints
 *    (e.g. `top-secret`, `need-to-know`) cannot be ranked against the built-in
 *    lattice — it is withheld by default rather than silently indexed (#102).
 *    Only a genuinely ABSENT label fails open (treated as public/unlabeled).
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
 *
 * Mirrors the CLI's `CLASSIFICATION_RANK` (kbexplorer-cli `lib/access-label`)
 * so the two surfaces agree. Keys are the recognized built-ins; any token NOT
 * present here is a bespoke classification that ranks at
 * {@link TOP_CLASSIFICATION_SEVERITY} (see {@link classificationSeverity}).
 */
export const CLASSIFICATION_SEVERITY: Record<KBAccessClassification, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
  unknown: 5,
};

/**
 * Visibility severity lattice (higher = more sensitive), mirroring the CLI's
 * `VISIBILITY_RANK`. `private > internal > public > absent`. Keys are the
 * recognized built-ins; any other token is bespoke and ranks at
 * {@link TOP_VISIBILITY_SEVERITY}.
 */
export const VISIBILITY_SEVERITY: Record<KBAccessVisibility, number> = {
  public: 1,
  internal: 2,
  private: 3,
};

/** Severity used when a label omits `classification` entirely (`absent`). */
export const ABSENT_CLASSIFICATION_SEVERITY = 0;

/**
 * Severity assigned to an UNRECOGNIZED (bespoke) classification token. It ranks
 * at the top (most-restrictive) tier — `unknown` — so a token that can't be
 * ranked against the built-ins fails CLOSED, matching the CLI lattice's
 * treatment of unrecognized tokens (`ACCESS_TOP_CLASSIFICATION`).
 */
export const TOP_CLASSIFICATION_SEVERITY = CLASSIFICATION_SEVERITY.unknown;

/** Severity assigned to an UNRECOGNIZED (bespoke) visibility token — `private`. */
export const TOP_VISIBILITY_SEVERITY = VISIBILITY_SEVERITY.private;

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
 * Default-SAFE exclusion policy: withhold confidential/restricted/unknown
 * classification and `private` visibility from the committed index. These are
 * restriction levels whose content should not sit in a checked-in,
 * potentially-broadly-readable search index. `public`/`internal` stay indexed.
 * The listed built-ins are overridable via {@link AccessExclusionConfig} (e.g.
 * a deployment may re-include `confidential`) — but any *bespoke* token outside
 * the built-in lattice is always withheld regardless of this list, since it
 * cannot be ranked as safe ({@link isExcludedByAccess}, #102).
 *
 * TODO(#102-followup): this exclusion policy should live in core as the single
 * source of truth; kbexplorer-template hand-duplicates it (and both are wider
 * than core's documented default, which withholds only restricted/unknown).
 */
export const DEFAULT_ACCESS_EXCLUSION: AccessExclusionConfig = {
  mode: 'exclude',
  excludedClassifications: ['confidential', 'restricted', 'unknown'],
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
 * {@link ABSENT_CLASSIFICATION_SEVERITY} when no classification is present, and
 * {@link TOP_CLASSIFICATION_SEVERITY} for a bespoke token outside the built-in
 * lattice (fail-closed — mirrors the CLI's `classificationRank`).
 */
export function classificationSeverity(label?: KBAccessLabel): number {
  const classification = label?.classification;
  if (!classification) return ABSENT_CLASSIFICATION_SEVERITY;
  return CLASSIFICATION_SEVERITY[classification] ?? TOP_CLASSIFICATION_SEVERITY;
}

/**
 * Decide whether a single label token is withheld, FAIL-CLOSED.
 *
 * A token is withheld when it is EITHER a recognized built-in the config lists
 * as excluded, OR an unrecognized/bespoke token (one absent from `lattice`).
 * The bespoke branch is the #102 fix: an open-union token that can't be ranked
 * against the built-ins can never be treated as safe, so it is always withheld
 * — independent of the (overridable) excluded list, which only governs the
 * recognized tiers.
 */
function isTokenExcluded(
  token: string,
  lattice: Record<string, number>,
  excluded: readonly string[],
): boolean {
  if (!(token in lattice)) return true; // bespoke → fail-closed
  return excluded.includes(token);
}

/**
 * Decide whether a resource carrying `label` is excluded from the committed
 * index under `config`.
 *
 * Pure function of (label, config). A resource is excluded when EITHER its
 * classification OR its visibility is withheld (see {@link isTokenExcluded}):
 * a recognized tier the config excludes, or ANY bespoke token outside the
 * built-in lattice (fail-closed, #102). A missing label — or a label whose
 * classification/visibility is empty/absent — is never excluded on that axis;
 * genuinely unlabeled content is indexed as ordinary (the documented, and only,
 * fail-open case).
 */
export function isExcludedByAccess(
  label: KBAccessLabel | undefined,
  config: AccessExclusionConfig,
): boolean {
  if (!label) return false;
  if (
    label.classification &&
    isTokenExcluded(
      label.classification,
      CLASSIFICATION_SEVERITY,
      config.excludedClassifications,
    )
  ) {
    return true;
  }
  if (
    label.visibility &&
    isTokenExcluded(label.visibility, VISIBILITY_SEVERITY, config.excludedVisibilities)
  ) {
    return true;
  }
  return false;
}
