import { createHash } from 'node:crypto';

export function normalizeText(content: string) {
  return content
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, (url) => normalizeUrl(url))
    .replace(/[^\p{L}\p{N}\s.:/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sha256(value: string | Buffer | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

export function textHash(content: string) {
  const normalized = normalizeText(content);
  return normalized ? sha256(normalized) : null;
}

export function shingles(content: string, size = 4) {
  const words = normalizeText(content).split(' ').filter(Boolean);
  if (words.length === 0) return new Set<string>();
  if (words.length <= size) return new Set([words.join(' ')]);

  const values = new Set<string>();
  for (let index = 0; index <= words.length - size; index += 1) {
    values.add(words.slice(index, index + size).join(' '));
  }
  return values;
}

export function jaccard(a: Set<string>, b: Set<string>) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export function domains(content: string) {
  const found = new Set<string>();
  for (const match of content.matchAll(/https?:\/\/([^\s/]+)/gi)) {
    const host = match[1]?.toLowerCase().replace(/^www\./, '');
    if (host) found.add(host);
  }
  return [...found].sort();
}

function normalizeUrl(raw: string) {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return raw;
  }
}
