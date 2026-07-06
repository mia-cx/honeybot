import type { Message } from 'discord.js';
import type { LoadedConfig } from '../config.js';
import { logger } from '../logger.js';
import type { ScamClassifier } from '../services/classifier.js';
import type { DuplicateDetector } from '../services/duplicateDetector.js';
import type { GlobalBanList } from '../services/globalBanList.js';
import type { MessageCache } from '../services/messageCache.js';
import {
  applyImmediateHoneypotTimeout,
  applyScamAction,
  deleteMessage,
  hasBypass,
} from '../services/moderation.js';
import type { CachedMessage, GuildModerationConfig } from '../types.js';

type MessageCreateDependencies = {
  config: LoadedConfig;
  messageCache: MessageCache;
  duplicateDetector: DuplicateDetector;
  classifier: ScamClassifier;
  globalBanList: GlobalBanList;
};

export async function handleMessageCreate(
  message: Message,
  dependencies: MessageCreateDependencies,
) {
  if (!message.inGuild()) return;
  if (message.author.bot) return;

  const guildConfig = dependencies.config.guilds[message.guildId];
  if (!guildConfig) return;

  const member = message.member ?? (await message.guild.members.fetch(message.author.id));
  if (hasBypass(member, guildConfig)) return;

  if (guildConfig.honeypotChannelIds.includes(message.channelId)) {
    await handleHoneypotMessage(message, member.id, guildConfig, dependencies);
    return;
  }

  if (dependencies.duplicateDetector.record(message, guildConfig)) {
    await handleDuplicateMessage(message, member.id, guildConfig, dependencies);
  }
}

async function handleHoneypotMessage(
  message: Message<true>,
  memberId: string,
  guildConfig: GuildModerationConfig,
  dependencies: MessageCreateDependencies,
) {
  const cached = dependencies.messageCache.cache(message, 'honeypot');
  const member = await message.guild.members.fetch(memberId);

  await attempt('timeout honeypot user', () => applyImmediateHoneypotTimeout(member, guildConfig), {
    guildId: message.guildId,
    userId: memberId,
  });

  await attempt('delete honeypot message', () => deleteMessage(message), {
    guildId: message.guildId,
    messageId: message.id,
  });

  await classifyAndMaybePunish(cached, message, guildConfig, dependencies);
}

async function handleDuplicateMessage(
  message: Message<true>,
  memberId: string,
  guildConfig: GuildModerationConfig,
  dependencies: MessageCreateDependencies,
) {
  const cached = dependencies.messageCache.cache(message, 'duplicate');

  logger.info('Duplicate message threshold reached', {
    guildId: message.guildId,
    userId: memberId,
    channelId: message.channelId,
    messageId: message.id,
  });

  await classifyAndMaybePunish(cached, message, guildConfig, dependencies);
}

async function classifyAndMaybePunish(
  cached: CachedMessage,
  message: Message<true>,
  guildConfig: GuildModerationConfig,
  dependencies: MessageCreateDependencies,
) {
  const classification = await dependencies.classifier.classify(cached);

  logger.info('Message classified', {
    guildId: cached.guildId,
    messageId: cached.id,
    verdict: classification.verdict,
    confidence: classification.confidence,
  });

  if (classification.verdict !== 'scam') return;

  await attempt('delete scam message', () => deleteMessage(message), {
    guildId: cached.guildId,
    messageId: cached.id,
  });

  const member = await message.guild.members.fetch(cached.authorId);
  await applyScamAction(member, guildConfig);
  await dependencies.globalBanList.reportScam(cached, classification);
}

async function attempt(
  label: string,
  operation: () => Promise<void>,
  context: Record<string, unknown>,
) {
  try {
    await operation();
  } catch (error) {
    logger.warn(`Failed to ${label}`, {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
