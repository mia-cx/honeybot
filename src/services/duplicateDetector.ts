import type { Message } from 'discord.js';
import type { GuildConfig } from '../domain/types.js';
import { domains, normalizeText } from '../utils/fingerprints.js';

type DuplicateEntry = {
  userId: string;
  channelId: string;
  messageId: string;
  timestamp: number;
};

export type DuplicateMessageRef = {
  channelId: string;
  messageId: string;
};

export type DuplicateDetectionResult = {
  matched: boolean;
  channelIds: string[];
  messages: DuplicateMessageRef[];
};

export class DuplicateDetector {
  private readonly entries = new Map<string, DuplicateEntry[]>();

  record(
    message: Message<true>,
    config: GuildConfig,
  ): DuplicateDetectionResult {
    if (!config.crosschannelEnabled)
      return { matched: false, channelIds: [], messages: [] };

    const normalized = normalizeText(message.content);
    const domainKey = domains(message.content).join(',');
    const attachmentKey = message.attachments
      .map((attachment) => attachment.name ?? attachment.id)
      .join(',');
    const signal = normalized || domainKey || attachmentKey;
    if (!signal) return { matched: false, channelIds: [], messages: [] };

    const now = Date.now();
    const key = `${message.guildId}:${message.author.id}:${signal}`;
    const windowMs = config.crosschannelWindowSeconds * 1000;
    const fresh = (this.entries.get(key) ?? []).filter(
      (entry) => now - entry.timestamp <= windowMs,
    );

    fresh.push({
      userId: message.author.id,
      channelId: message.channelId,
      messageId: message.id,
      timestamp: now,
    });
    this.entries.set(key, fresh.slice(-config.crosschannelMaxEntriesPerUser));

    const channelIds = [...new Set(fresh.map((entry) => entry.channelId))];
    const messages = fresh.map(({ channelId, messageId }) => ({
      channelId,
      messageId,
    }));
    return {
      matched: channelIds.length >= config.crosschannelChannelThreshold,
      channelIds,
      messages,
    };
  }

  sweep(maxAgeMs = 10 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, entries] of this.entries) {
      const fresh = entries.filter((entry) => entry.timestamp >= cutoff);
      if (fresh.length === 0) this.entries.delete(key);
      else this.entries.set(key, fresh);
    }
  }
}
