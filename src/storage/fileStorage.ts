import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256 } from '../utils/fingerprints.js';
import { normalizeAttachmentFile } from './imageNormalization.js';

export type StoredFile = {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  path: string;
  contentType: string | null;
  fileName: string;
  normalized: boolean;
};

export class FileStorage {
  constructor(private readonly rootDir: string) {}

  async saveFromUrl(
    url: string,
    parts: string[],
    fallbackName: string,
    options: { contentType?: string | null } = {},
  ): Promise<StoredFile> {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Failed to download attachment: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    const downloaded = Buffer.from(arrayBuffer);
    const stored = await normalizeAttachmentFile(
      downloaded,
      options.contentType ?? response.headers.get('content-type'),
      fallbackName,
    );
    const digest = sha256(stored.buffer);
    const safeName = safeBasename(stored.fileName);
    const storageKey = [...parts, `${digest}-${safeName}`].join('/');
    const path = this.pathFor(storageKey);

    await mkdir(join(this.rootDir, ...parts), { recursive: true });
    await writeFile(path, stored.buffer);

    return {
      storageKey,
      sha256: digest,
      sizeBytes: stored.buffer.byteLength,
      path,
      contentType: stored.contentType,
      fileName: stored.fileName,
      normalized: stored.normalized,
    };
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
  return (
    basename(name)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 80) || 'attachment.bin'
  );
}
