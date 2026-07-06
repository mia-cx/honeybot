import type { Message } from 'discord.js';
import type { GuildModerationConfig } from '../types.js';

type DuplicateEntry = {
  channelId: string;
  messageId: string;
  timestamp: number;
};

export class DuplicateDetector {
  private readonly entries = new Map<string, DuplicateEntry[]>();

  record(message: Message<true>, config: GuildModerationConfig): boolean {
    const normalized = normalizeMessage(message.content);
    if (!normalized) return false;

    const now = Date.now();
    const key = `${message.guildId}:${message.author.id}:${normalized}`;
    const windowMs = config.duplicateWindowSeconds * 1000;
    const existing = this.entries.get(key) ?? [];
    const fresh = existing.filter((entry) => now - entry.timestamp <= windowMs);

    fresh.push({
      channelId: message.channelId,
      messageId: message.id,
      timestamp: now,
    });

    this.entries.set(key, fresh);

    const distinctChannelCount = new Set(fresh.map((entry) => entry.channelId)).size;
    return distinctChannelCount >= config.duplicateChannelThreshold;
  }

  sweep(maxAgeMs = 10 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;

    for (const [key, entries] of this.entries) {
      const fresh = entries.filter((entry) => entry.timestamp >= cutoff);
      if (fresh.length === 0) {
        this.entries.delete(key);
        continue;
      }

      this.entries.set(key, fresh);
    }
  }
}

function normalizeMessage(content: string) {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}
