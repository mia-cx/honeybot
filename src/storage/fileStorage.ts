import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256 } from '../utils/fingerprints.js';
import { normalizeAttachmentFile } from './imageNormalization.js';

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const ATTACHMENT_FETCH_TIMEOUT_MS = 10_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const MAX_ATTACHMENTS_PER_CASE = 32;

export type StoredFile = {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  path: string;
  contentType: string | null;
  fileName: string;
  normalized: boolean;
};

export type FileStorageLimits = {
  maxAttachmentBytes?: number;
  fetchTimeoutMs?: number;
};

export class AttachmentResourceLimitError extends Error {}

export class FileStorage {
  constructor(
    private readonly rootDir: string,
    private readonly limits: FileStorageLimits = {},
  ) {}

  async saveFromUrl(
    url: string,
    parts: string[],
    fallbackName: string,
    options: {
      contentType?: string | null;
      expectedSizeBytes?: number;
    } = {},
  ): Promise<StoredFile> {
    const maxBytes = this.limits.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
    if (
      options.expectedSizeBytes !== undefined &&
      options.expectedSizeBytes > maxBytes
    ) {
      throw new AttachmentResourceLimitError(
        `Attachment exceeds the ${maxBytes} byte download limit`,
      );
    }

    const response = await fetch(url, {
      signal: AbortSignal.timeout(
        this.limits.fetchTimeoutMs ?? ATTACHMENT_FETCH_TIMEOUT_MS,
      ),
    });
    if (!response.ok)
      throw new Error(`Failed to download attachment: ${response.status}`);

    const downloaded = await readBoundedResponse(response, maxBytes);
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

async function readBoundedResponse(response: Response, maxBytes: number) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new AttachmentResourceLimitError(
        `Attachment exceeds the ${maxBytes} byte download limit`,
      );
    }
  }

  if (!response.body) throw new Error('Attachment response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AttachmentResourceLimitError(
          `Attachment exceeds the ${maxBytes} byte download limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, receivedBytes);
}

function safeBasename(name: string) {
  return (
    basename(name)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 80) || 'attachment.bin'
  );
}
