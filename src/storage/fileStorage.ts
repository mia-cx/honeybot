import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256 } from '../utils/fingerprints.js';

export type StoredFile = {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  path: string;
};

export class FileStorage {
  constructor(private readonly rootDir: string) {}

  async saveFromUrl(url: string, parts: string[], fallbackName: string): Promise<StoredFile> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download attachment: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const digest = sha256(buffer);
    const safeName = safeBasename(fallbackName);
    const storageKey = [...parts, `${digest}-${safeName}`].join('/');
    const path = this.pathFor(storageKey);

    await mkdir(join(this.rootDir, ...parts), { recursive: true });
    await writeFile(path, buffer);

    return { storageKey, sha256: digest, sizeBytes: buffer.byteLength, path };
  }

  async read(storageKey: string) {
    return readFile(this.pathFor(storageKey));
  }

  stream(storageKey: string) {
    return createReadStream(this.pathFor(storageKey));
  }

  pathFor(storageKey: string) {
    return join(this.rootDir, storageKey);
  }

  async remove(storageKey: string | null) {
    if (!storageKey) return;
    await rm(this.pathFor(storageKey), { force: true });
  }
}

function safeBasename(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'attachment.bin';
}
