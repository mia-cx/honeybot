import sharp from 'sharp';
import heicConvert from 'heic-convert';

export const normalizedImageContentType = 'image/webp';

export type NormalizedAttachmentFile = {
  buffer: Buffer;
  contentType: string | null;
  fileName: string;
  normalized: boolean;
};

export async function normalizeAttachmentFile(
  buffer: Buffer,
  contentType: string | null | undefined,
  fileName: string,
): Promise<NormalizedAttachmentFile> {
  const cleanContentType =
    contentTypeWithoutParameters(contentType) ??
    imageContentTypeFromName(fileName);
  if (!cleanContentType?.startsWith('image/')) {
    return originalFile(buffer, cleanContentType, fileName);
  }

  const normalized =
    (await normalizeWithSharp(buffer).catch(async () =>
      isHeic(cleanContentType, fileName)
        ? normalizeHeicWithFallback(buffer).catch(() => null)
        : null,
    )) ?? null;

  if (!normalized) return originalFile(buffer, cleanContentType, fileName);

  return {
    buffer: normalized,
    contentType: normalizedImageContentType,
    fileName: withExtension(fileName, '.webp'),
    normalized: true,
  };
}

async function normalizeWithSharp(buffer: Buffer) {
  return sharp(buffer, { animated: false })
    .rotate()
    .webp({ quality: 90 })
    .toBuffer();
}

async function normalizeHeicWithFallback(buffer: Buffer) {
  const converted = await heicConvert({
    buffer,
    format: 'JPEG',
    quality: 0.92,
  });
  const jpegBuffer = Buffer.from(
    converted instanceof ArrayBuffer ? new Uint8Array(converted) : converted,
  );
  return normalizeWithSharp(jpegBuffer);
}

function originalFile(
  buffer: Buffer,
  contentType: string | null | undefined,
  fileName: string,
): NormalizedAttachmentFile {
  return {
    buffer,
    contentType: contentType ?? null,
    fileName,
    normalized: false,
  };
}

function isHeic(contentType: string, fileName: string) {
  const lowerName = fileName.toLowerCase();
  return (
    contentType === 'image/heic' ||
    contentType === 'image/heif' ||
    lowerName.endsWith('.heic') ||
    lowerName.endsWith('.heif')
  );
}

function contentTypeWithoutParameters(contentType: string | null | undefined) {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() || null;
}

function imageContentTypeFromName(fileName: string) {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.gif')) return 'image/gif';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';
  if (lowerName.endsWith('.heic')) return 'image/heic';
  if (lowerName.endsWith('.heif')) return 'image/heif';
  return null;
}

function withExtension(fileName: string, extension: string) {
  const lastSlashIndex = Math.max(
    fileName.lastIndexOf('/'),
    fileName.lastIndexOf('\\'),
  );
  const basenameStart = lastSlashIndex + 1;
  const dotIndex = fileName.lastIndexOf('.');
  const hasExtension = dotIndex > basenameStart;
  return `${hasExtension ? fileName.slice(0, dotIndex) : fileName}${extension}`;
}
