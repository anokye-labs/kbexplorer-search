import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACCESS_EXCLUSION,
  CLASSIFICATION_SEVERITY,
  ABSENT_CLASSIFICATION_SEVERITY,
  resolveAccessConfig,
  classificationSeverity,
  isExcludedByAccess,
  type AccessExclusionConfig,
} from '../src/access.js';
import type { KBAccessLabel } from '../src/kbexplorer-types.js';

describe('access lattice', () => {
  it('orders unknown > restricted > confidential > internal > public > absent', () => {
    expect(ABSENT_CLASSIFICATION_SEVERITY).toBeLessThan(CLASSIFICATION_SEVERITY.public);
    expect(CLASSIFICATION_SEVERITY.public).toBeLessThan(CLASSIFICATION_SEVERITY.internal);
    expect(CLASSIFICATION_SEVERITY.internal).toBeLessThan(CLASSIFICATION_SEVERITY.confidential);
    expect(CLASSIFICATION_SEVERITY.confidential).toBeLessThan(CLASSIFICATION_SEVERITY.restricted);
    expect(CLASSIFICATION_SEVERITY.restricted).toBeLessThan(CLASSIFICATION_SEVERITY.unknown);
  });

  it('treats a missing label/classification as absent (least sensitive)', () => {
    expect(classificationSeverity(undefined)).toBe(ABSENT_CLASSIFICATION_SEVERITY);
    expect(classificationSeverity({})).toBe(ABSENT_CLASSIFICATION_SEVERITY);
    expect(classificationSeverity({ classification: 'restricted' })).toBe(
      CLASSIFICATION_SEVERITY.restricted,
    );
  });
});

describe('resolveAccessConfig', () => {
  it('defaults to the SAFE policy when nothing is supplied', () => {
    expect(resolveAccessConfig()).toEqual(DEFAULT_ACCESS_EXCLUSION);
  });

  it('applies SAFE defaults for omitted fields without mutating input', () => {
    const partial = { mode: 'include' as const };
    const resolved = resolveAccessConfig(partial);
    expect(resolved.mode).toBe('include');
    expect(resolved.excludedClassifications).toEqual(['confidential', 'restricted', 'unknown']);
    expect(resolved.excludedVisibilities).toEqual(['private']);
    expect(partial).toEqual({ mode: 'include' });
  });
});

describe('isExcludedByAccess', () => {
  const config = DEFAULT_ACCESS_EXCLUSION;

  it('indexes unlabeled and public/internal content', () => {
    expect(isExcludedByAccess(undefined, config)).toBe(false);
    expect(isExcludedByAccess({}, config)).toBe(false);
    expect(isExcludedByAccess({ classification: 'public' }, config)).toBe(false);
    expect(isExcludedByAccess({ classification: 'internal' }, config)).toBe(false);
  });

  it('excludes confidential, restricted and unknown classifications by default', () => {
    expect(isExcludedByAccess({ classification: 'confidential' }, config)).toBe(true);
    expect(isExcludedByAccess({ classification: 'restricted' }, config)).toBe(true);
    expect(isExcludedByAccess({ classification: 'unknown' }, config)).toBe(true);
  });

  it('excludes private visibility by default', () => {
    expect(isExcludedByAccess({ visibility: 'private' }, config)).toBe(true);
    expect(isExcludedByAccess({ visibility: 'internal' }, config)).toBe(false);
    expect(isExcludedByAccess({ visibility: 'public' }, config)).toBe(false);
  });

  it('excludes when EITHER axis matches', () => {
    const label: KBAccessLabel = { classification: 'public', visibility: 'private' };
    expect(isExcludedByAccess(label, config)).toBe(true);
  });

  it('honours config overrides', () => {
    const strict: AccessExclusionConfig = {
      mode: 'exclude',
      excludedClassifications: ['confidential', 'restricted', 'unknown'],
      excludedVisibilities: ['private', 'internal'],
    };
    expect(isExcludedByAccess({ classification: 'confidential' }, strict)).toBe(true);
    expect(isExcludedByAccess({ visibility: 'internal' }, strict)).toBe(true);

    const lax: AccessExclusionConfig = {
      mode: 'exclude',
      excludedClassifications: [],
      excludedVisibilities: [],
    };
    expect(isExcludedByAccess({ classification: 'restricted' }, lax)).toBe(false);
    expect(isExcludedByAccess({ visibility: 'private' }, lax)).toBe(false);
  });

  it('is a pure function of (label, config) — no side effects', () => {
    const label: KBAccessLabel = { classification: 'restricted' };
    const snapshot = JSON.stringify(label);
    isExcludedByAccess(label, config);
    isExcludedByAccess(label, config);
    expect(JSON.stringify(label)).toBe(snapshot);
  });
});
