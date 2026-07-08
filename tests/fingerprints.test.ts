import { describe, expect, it } from 'vitest';
import { domains, jaccard, normalizeText, sha256, shingles, textHash } from '../src/utils/fingerprints.js';

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

  it('builds shingles for empty, short, and long text', () => {
    expect(shingles('')).toEqual(new Set());
    expect(shingles('one two')).toEqual(new Set(['one two']));
    expect(shingles('one two three four five', 3)).toEqual(new Set(['one two three', 'two three four', 'three four five']));
  });

  it('scores set overlap with jaccard and hashes buffers', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(sha256(Buffer.from('x'))).toBe(sha256('x'));
    expect(textHash('!!!')).toBeNull();
  });
});
