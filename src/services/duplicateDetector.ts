import type { Message } from 'discord.js';
import type { GuildConfig } from '../domain/types.js';
import { domains, normalizeText } from '../utils/fingerprints.js';

const TEXT_ONLY_MINIMUM_WINDOW_SECONDS = 2;

type DuplicateEntry = {
  userId: string;
  channelId: string;
  messageId: string;
  timestamp: number;
  hasAttachments: boolean;
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
    const maxWindowMs = config.crosschannelWindowSeconds * 1000;
    const fresh = (this.entries.get(key) ?? []).filter(
      (entry) => now - entry.timestamp <= maxWindowMs,
    );

    fresh.push({
      userId: message.author.id,
      channelId: message.channelId,
      messageId: message.id,
      timestamp: now,
      hasAttachments: message.attachments.size > 0,
    });
    this.entries.set(key, fresh.slice(-config.crosschannelMaxEntriesPerUser));

    const match = matchingWindow(fresh, config);
    const resultEntries = match ?? fresh;
    return {
      matched: match !== null,
      channelIds: uniqueChannelIds(resultEntries),
      messages: resultEntries.map(({ channelId, messageId }) => ({
        channelId,
        messageId,
      })),
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

function matchingWindow(
  entries: DuplicateEntry[],
  config: GuildConfig,
): DuplicateEntry[] | null {
  const latest = entries.at(-1);
  if (!latest) return null;

  for (let start = 0; start < entries.length; start += 1) {
    const candidate = entries.slice(start);
    const channelCount = uniqueChannelIds(candidate).length;
    if (channelCount < config.crosschannelChannelThreshold) continue;

    const elapsedSeconds = (latest.timestamp - candidate[0]!.timestamp) / 1000;
    const minimumWindowSeconds = candidate.some(
      (entry) => entry.hasAttachments,
    )
      ? config.crosschannelMinimumWindowSeconds
      : TEXT_ONLY_MINIMUM_WINDOW_SECONDS;
    if (
      elapsedSeconds <=
      crosschannelAllowedWindowSeconds(
        channelCount,
        config,
        minimumWindowSeconds,
      )
    ) {
      return candidate;
    }
  }

  return null;
}

/** Returns the allowed duplicate interval for a channel count and curve minimum. */
export function crosschannelAllowedWindowSeconds(
  channelCount: number,
  config: Pick<
    GuildConfig,
    | 'crosschannelMinimumWindowSeconds'
    | 'crosschannelWindowSeconds'
    | 'crosschannelWindowSteepness'
    | 'crosschannelWindowMidpointChannels'
  >,
  minimumWindowSeconds = config.crosschannelMinimumWindowSeconds,
) {
  if (channelCount < 2) return 0;
  const sigmoid = (x: number) =>
    1 /
    (1 +
      Math.exp(
        -config.crosschannelWindowSteepness *
          (x - config.crosschannelWindowMidpointChannels),
      ));
  const floor = sigmoid(2);
  const normalized = (sigmoid(channelCount) - floor) / (1 - floor);
  const curvedWindow =
    minimumWindowSeconds +
    (config.crosschannelWindowSeconds - minimumWindowSeconds) * normalized;

  return Math.min(
    config.crosschannelWindowSeconds,
    Math.max(minimumWindowSeconds, curvedWindow),
  );
}

function uniqueChannelIds(entries: DuplicateEntry[]) {
  return [...new Set(entries.map((entry) => entry.channelId))];
}
