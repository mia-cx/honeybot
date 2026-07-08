import { describe, expect, it } from 'vitest';
import { domains, jaccard, normalizeText, textHash } from '../src/utils/fingerprints.js';

describe('fingerprints', () => {
  it('normalizes whitespace, casing, punctuation, and URLs', () => {
    expect(normalizeText('  FREE   Nitro!!! https://www.discord-nitro.gift/claim?x=1#y  ')).toBe(
      'free nitro discord-nitro.gift/claim',
    );
  });

  it('hashes equivalent normalized text to the same value', () => {
    expect(textHash('FREE Nitro')).toBe(textHash(' free   nitro '));
  });

  it('extracts stable domains', () => {
    expect(domains('one https://www.example.com/a two http://foo.test/x')).toEqual([
      'example.com',
      'foo.test',
    ]);
  });

  it('scores set overlap with jaccard', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });
});
