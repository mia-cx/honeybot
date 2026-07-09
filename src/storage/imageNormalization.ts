import sharp from 'sharp';

export const normalizedImageContentType = 'image/webp';
export const MAX_IMAGE_PIXELS = 40_000_000;
export const IMAGE_PROCESSING_TIMEOUT_SECONDS = 5;

export type NormalizedAttachmentFile = {
  buffer: Buffer;
  contentType: string | null;
  fileName: string;
  normalized: boolean;
};

export type ImageNormalizationLimits = {
  maxInputPixels?: number;
  timeoutSeconds?: number;
};

export class UnsafeImageError extends Error {}

export async function normalizeAttachmentFile(
  buffer: Buffer,
  contentType: string | null | undefined,
  fileName: string,
  limits: ImageNormalizationLimits = {},
): Promise<NormalizedAttachmentFile> {
  const cleanContentType =
    contentTypeWithoutParameters(contentType) ??
    imageContentTypeFromName(fileName);
  if (!cleanContentType?.startsWith('image/')) {
    return originalFile(buffer, cleanContentType, fileName);
  }

  let normalized: Buffer;
  try {
    normalized = await normalizeWithSharp(buffer, limits);
  } catch (error) {
    throw new UnsafeImageError('Image could not be normalized safely', {
      cause: error,
    });
  }

  return {
    buffer: normalized,
    contentType: normalizedImageContentType,
    fileName: withExtension(fileName, '.webp'),
    normalized: true,
  };
}

async function normalizeWithSharp(
  buffer: Buffer,
  limits: ImageNormalizationLimits,
) {
  return sharp(buffer, {
    animated: false,
    failOn: 'warning',
    limitInputPixels: limits.maxInputPixels ?? MAX_IMAGE_PIXELS,
    sequentialRead: true,
  })
    .rotate()
    .webp({ quality: 90 })
    .timeout({
      seconds: limits.timeoutSeconds ?? IMAGE_PROCESSING_TIMEOUT_SECONDS,
    })
    .toBuffer();
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
