import type { Message } from 'discord.js';
import { logger } from '../logger.js';
import type { ConfigStore } from '../services/configStore.js';
import type { DuplicateDetector } from '../services/duplicateDetector.js';
import type { MessageCache } from '../services/messageCache.js';
import { deleteMessage, applyPolicy, dmPunishedUser, hasBypass, honeybotAuditReason } from '../services/moderation.js';
import type { CaseStore } from '../services/caseStore.js';
import type { EvidenceAnalyzer } from '../services/evidenceAnalyzer.js';
import type { FairQueue } from '../queues/fairQueue.js';
import type { FileStorage } from '../storage/fileStorage.js';
import type { AnalysisResult, GuildConfig, TriggerType } from '../domain/types.js';
import type { CachedAttachment } from '../types.js';
import { caseReviewEdit, caseReviewMessage } from '../interactions/caseReviewUi.js';

export type MessageCreateDependencies = {
  configStore: ConfigStore;
  messageCache: MessageCache;
  duplicateDetector: DuplicateDetector;
  caseStore: CaseStore;
  analyzer: EvidenceAnalyzer;
  moderationQueue: FairQueue;
  storage: FileStorage;
};

export async function handleMessageCreate(message: Message, dependencies: MessageCreateDependencies) {
  if (!message.inGuild()) return;
  if (message.author.bot || message.webhookId) return;

  const guildConfig = await dependencies.configStore.getGuildConfig(message.guildId);
  const member = message.member ?? (await message.guild.members.fetch(message.author.id));
  if (hasBypass(member, guildConfig)) return;

  if (guildConfig.honeypotChannelIds.includes(message.channelId)) {
    await handleTriggeredMessage(message, 'honeypot', guildConfig, dependencies);
    return;
  }

  const duplicate = dependencies.duplicateDetector.record(message, guildConfig);
  if (duplicate.matched) {
    await handleTriggeredMessage(message, 'crosschannel', guildConfig, dependencies, duplicate.channelIds);
  }
}

async function handleTriggeredMessage(
  message: Message<true>,
  triggerType: TriggerType,
  guildConfig: GuildConfig,
  dependencies: MessageCreateDependencies,
  duplicateChannelIds: string[] = [],
) {
  const policy = guildConfig.policies[triggerType === 'honeypot' ? 'honeypot_prevention' : 'crosschannel_prevention'];
  const moderationReason = `Honeybot ${triggerType} prevention`;
  const caseRow = await dependencies.caseStore.getOrCreateCase({ guildId: message.guildId, userId: message.author.id, triggerType, reason: moderationReason });
  const persisted = await dependencies.caseStore.attachMessage(caseRow.id, message);
  const cached = dependencies.messageCache.cache(
    message,
    triggerType === 'honeypot' ? 'honeypot' : 'crosschannel',
    persisted.attachments.map<CachedAttachment>((attachment) => ({
      id: attachment.discordAttachmentId,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.sizeBytes,
      url: attachment.originalUrl,
      proxyUrl: attachment.reviewAttachmentUrl ?? attachment.originalUrl,
      sha256: attachment.sha256,
      storageKey: attachment.storageKey,
    })),
  );

  await dependencies.caseStore.addEvent(caseRow.id, 'prevention_applied', 'bot', null, moderationReason, { policy });
  const member = await message.guild.members.fetch(message.author.id);

  let triggerMessageDeleted = false;
  if (policy.deleteMessages) {
    await attempt('delete trigger message', async () => {
      triggerMessageDeleted = await deleteMessage(message);
      if (triggerMessageDeleted) await dependencies.caseStore.markMessageDeleted(message.id);
    });
  }

  await dependencies.moderationQueue.enqueue(message.guildId, () =>
    applyPolicy(
      member,
      policy,
      honeybotAuditReason({ caseId: caseRow.id, triggerType, decisionSource: 'prevention', confidence: null, actorId: null }),
    ),
  );
  const preventionAppliedAtMs = Date.now();
  await upsertReviewIfConfigured(message, caseRow.id, guildConfig, dependencies, {
    status: 'Prevention applied; analysis starting.',
    reason: moderationReason,
    duplicateChannelIds,
    triggerMessageDeleted,
    preventionAppliedAtMs,
    analysis: null,
  });

  if (policy.actionType === 'kick' || policy.actionType === 'ban') {
    await upsertReviewIfConfigured(message, caseRow.id, guildConfig, dependencies, {
      status: 'Prevention complete; analysis skipped.',
      reason: 'Prevention already kicked/banned the user; expensive analysis skipped.',
      duplicateChannelIds,
      triggerMessageDeleted,
      preventionAppliedAtMs,
      analysis: null,
    });
    return;
  }

  const analysis = await dependencies.analyzer.analyze(caseRow.id, cached, guildConfig);
  await upsertReviewIfConfigured(message, caseRow.id, guildConfig, dependencies, {
    status: 'Analysis complete; awaiting moderator review.',
    reason: analysis.reason,
    duplicateChannelIds,
    triggerMessageDeleted,
    preventionAppliedAtMs,
    analysis,
  });

  if (guildConfig.reviewBypassEnabled && analysis.shouldPunish) {
    const punishment = guildConfig.policies.punishment;
    const auditReason = honeybotAuditReason({ caseId: caseRow.id, triggerType, decisionSource: 'review-bypass', confidence: analysis.confidence, actorId: null });
    if (guildConfig.punishmentDmNotify) {
      await dmPunishedUser({ member, caseId: caseRow.id, action: punishment.actionType, reason: analysis.reason, auditReason, caseStore: dependencies.caseStore, storage: dependencies.storage });
    }
    await dependencies.moderationQueue.enqueue(message.guildId, () => applyPolicy(member, punishment, auditReason));
    await dependencies.caseStore.resolve(caseRow.id, 'punished', punishment.actionType, null, analysis.reason);
    await upsertReviewIfConfigured(message, caseRow.id, guildConfig, dependencies, {
      status: 'Auto-punished by review bypass.',
      reason: analysis.reason,
      duplicateChannelIds,
      triggerMessageDeleted,
      preventionAppliedAtMs,
      analysis,
    });
  }
}

async function upsertReviewIfConfigured(
  message: Message<true>,
  caseId: string,
  guildConfig: GuildConfig,
  dependencies: MessageCreateDependencies,
  state: {
    status: string;
    reason: string;
    duplicateChannelIds: string[];
    triggerMessageDeleted: boolean;
    preventionAppliedAtMs: number;
    analysis: AnalysisResult | null;
  },
) {
  if (!guildConfig.moderationChannelId) return;
  const channel = await message.guild.channels.fetch(guildConfig.moderationChannelId);
  if (!channel?.isTextBased()) return;

  const attachments = await dependencies.caseStore.listCaseAttachments(caseId);
  const triggerType = message.channelId === guildConfig.honeypotChannelIds.find((id) => id === message.channelId) ? 'honeypot' : 'crosschannel';
  const payload = {
    caseId,
    userId: message.author.id,
    channelId: message.channelId,
    triggerType,
    duplicateChannelIds: state.duplicateChannelIds,
    moderatorUserIds: guildConfig.moderatorUsers,
    moderatorRoleIds: guildConfig.moderatorRoles,
    status: state.status,
    reason: state.reason,
    messageContent: message.content,
    attachments,
    storage: dependencies.storage,
    prevention: guildConfig.policies[triggerType === 'honeypot' ? 'honeypot_prevention' : 'crosschannel_prevention'],
    punishment: guildConfig.policies.punishment,
    preventionApplied: true,
    preventionAppliedAtMs: state.preventionAppliedAtMs,
    triggerMessageDeleted: state.triggerMessageDeleted,
    analysis: state.analysis,
  };
  const caseRow = await dependencies.caseStore.getCase(caseId);

  if (caseRow?.reviewMessageId && 'messages' in channel) {
    const existing = await channel.messages.fetch(caseRow.reviewMessageId).catch(() => null);
    if (existing) {
      await existing.edit(caseReviewEdit(payload));
      return;
    }
  }

  const reviewMessage = await channel.send(caseReviewMessage(payload));
  await dependencies.caseStore.setReviewMessage(caseId, reviewMessage.channelId, reviewMessage.id);
}

async function attempt(label: string, operation: () => Promise<void>) {
  try {
    await operation();
  } catch (error) {
    logger.warn(`Failed to ${label}`, { error: error instanceof Error ? error.message : String(error) });
  }
}
