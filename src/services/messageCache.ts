import type { Message } from 'discord.js';
import type { CachedMessage } from '../types.js';
import { normalizeText, textHash } from '../utils/fingerprints.js';

const MAX_CACHED_MESSAGES = 500;

export class MessageCache {
  private readonly messages = new Map<string, CachedMessage>();

  cache(
    message: Message<true>,
    reason: CachedMessage['reason'],
    storedAttachments: CachedMessage['attachments'] = [],
  ): CachedMessage {
    const cached: CachedMessage = {
      id: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      content: message.content,
      normalizedContent: normalizeText(message.content),
      textHash: textHash(message.content),
      attachments:
        storedAttachments.length > 0
          ? storedAttachments
          : message.attachments.map((attachment) => ({
              id: attachment.id,
              name: attachment.name ?? null,
              contentType: attachment.contentType ?? null,
              size: attachment.size,
              url: attachment.url,
              proxyUrl: attachment.proxyURL,
              dataUrl: null,
              sha256: null,
              storageKey: null,
            })),
      createdAt: message.createdAt,
      reason,
    };

    this.messages.set(message.id, cached);
    this.trim();
    return cached;
  }

  get(messageId: string) {
    return this.messages.get(messageId) ?? null;
  }

  private trim() {
    if (this.messages.size <= MAX_CACHED_MESSAGES) return;
    const oldestKey = this.messages.keys().next().value as string | undefined;
    if (oldestKey) this.messages.delete(oldestKey);
  }
}
