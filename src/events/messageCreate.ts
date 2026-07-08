import type { Message } from 'discord.js';
import { logger } from '../logger.js';
import type { ConfigStore } from '../services/configStore.js';
import type {
  DuplicateDetector,
  DuplicateMessageRef,
} from '../services/duplicateDetector.js';
import type { MessageCache } from '../services/messageCache.js';
import {
  deleteMessage,
  applyPolicy,
  dmPunishedUser,
  hasBypass,
  honeybotAuditReason,
} from '../services/moderation.js';
import type { CaseStore } from '../services/caseStore.js';
import type { EvidenceAnalyzer } from '../services/evidenceAnalyzer.js';
import type { FairQueue } from '../queues/fairQueue.js';
import type { FileStorage } from '../storage/fileStorage.js';
import type {
  AnalysisResult,
  GuildConfig,
  TriggerType,
} from '../domain/types.js';
import type { CachedAttachment } from '../types.js';
import {
  caseReviewEdit,
  caseReviewMessage,
} from '../interactions/caseReviewUi.js';

export type MessageCreateDependencies = {
  configStore: ConfigStore;
  messageCache: MessageCache;
  duplicateDetector: DuplicateDetector;
  caseStore: CaseStore;
  analyzer: EvidenceAnalyzer;
  moderationQueue: FairQueue;
  storage: FileStorage;
};

export async function handleMessageCreate(
  message: Message,
  dependencies: MessageCreateDependencies,
) {
  if (!message.inGuild()) return;
  if (message.author.bot || message.webhookId) return;

  const guildConfig = await dependencies.configStore.getGuildConfig(
    message.guildId,
  );
  const member =
    message.member ?? (await message.guild.members.fetch(message.author.id));
  if (hasBypass(member, guildConfig)) return;

  if (guildConfig.honeypotChannelIds.includes(message.channelId)) {
    await handleTriggeredMessage(
      message,
      'honeypot',
      guildConfig,
      dependencies,
    );
    return;
  }

  const duplicate = dependencies.duplicateDetector.record(message, guildConfig);
  if (duplicate.matched) {
    await handleTriggeredMessage(
      message,
      'crosschannel',
      guildConfig,
      dependencies,
      duplicate.channelIds,
      duplicate.messages,
    );
  }
}

async function handleTriggeredMessage(
  message: Message<true>,
  triggerType: TriggerType,
  guildConfig: GuildConfig,
  dependencies: MessageCreateDependencies,
  duplicateChannelIds: string[] = [],
  duplicateMessages: DuplicateMessageRef[] = [],
) {
  const policy =
    guildConfig.policies[
      triggerType === 'honeypot'
        ? 'honeypot_prevention'
        : 'crosschannel_prevention'
    ];
  const moderationReason = `Honeybot ${triggerType} prevention`;
  const caseRow = await dependencies.caseStore.getOrCreateCase({
    guildId: message.guildId,
    userId: message.author.id,
    triggerType,
    reason: moderationReason,
  });
  const persisted = await dependencies.caseStore.attachMessage(
    caseRow.id,
    message,
  );
  const cachedAttachments = await Promise.all(
    persisted.attachments.map(
      async (attachment): Promise<CachedAttachment> => ({
        id: attachment.discordAttachmentId,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.sizeBytes,
        url: attachment.originalUrl,
        proxyUrl: attachment.reviewAttachmentUrl ?? attachment.originalUrl,
        dataUrl: await attachmentDataUrl(attachment, dependencies.storage),
        sha256: attachment.sha256,
        storageKey: attachment.storageKey,
      }),
    ),
  );
  const cached = dependencies.messageCache.cache(
    message,
    triggerType === 'honeypot' ? 'honeypot' : 'crosschannel',
    cachedAttachments,
  );

  await dependencies.caseStore.addEvent(
    caseRow.id,
    'prevention_applied',
    'bot',
    null,
    moderationReason,
    { policy },
  );
  const member = await message.guild.members.fetch(message.author.id);

  await dependencies.moderationQueue.enqueue(message.guildId, () =>
    applyPolicy(
      member,
      policy,
      honeybotAuditReason({
        caseId: caseRow.id,
        triggerType,
        decisionSource: 'prevention',
        confidence: null,
        actorId: null,
      }),
    ),
  );
  const preventionAppliedAtMs = Date.now();

  let triggerMessageDeleted = false;
  if (policy.deleteMessages) {
    if (triggerType === 'crosschannel') {
      const deletedMessageIds = await deleteCrosschannelMessages(
        message,
        duplicateMessages,
      );
      triggerMessageDeleted = deletedMessageIds.includes(message.id);
      if (triggerMessageDeleted) {
        await dependencies.caseStore.markMessageDeleted(message.id);
      }
    } else {
      await attempt('delete trigger message', async () => {
        triggerMessageDeleted = await deleteMessage(message);
        if (triggerMessageDeleted)
          await dependencies.caseStore.markMessageDeleted(message.id);
      });
    }
  }
  await upsertReviewIfConfigured(
    message,
    caseRow.id,
    guildConfig,
    dependencies,
    {
      status: 'Prevention applied; analysis starting.',
      reason: moderationReason,
      duplicateChannelIds,
      triggerMessageDeleted,
      preventionAppliedAtMs,
      analysis: null,
    },
  );

  if (policy.actionType === 'kick' || policy.actionType === 'ban') {
    await upsertReviewIfConfigured(
      message,
      caseRow.id,
      guildConfig,
      dependencies,
      {
        status: 'Prevention complete; analysis skipped.',
        reason:
          'Prevention already kicked/banned the user; expensive analysis skipped.',
        duplicateChannelIds,
        triggerMessageDeleted,
        preventionAppliedAtMs,
        analysis: null,
      },
    );
    return;
  }

  logger.info('Honeybot analysis starting', {
    caseId: caseRow.id,
    guildId: message.guildId,
    triggerType,
  });
  const analysis = await dependencies.analyzer
    .analyze(caseRow.id, cached, guildConfig, async ({ phase, result }) => {
      await upsertReviewIfConfigured(
        message,
        caseRow.id,
        guildConfig,
        dependencies,
        {
          status: analysisProgressStatus(phase),
          reason: result.reason,
          duplicateChannelIds,
          triggerMessageDeleted,
          preventionAppliedAtMs,
          analysis: result,
        },
      ).catch((error: unknown) => {
        logger.warn('Failed to update analysis progress', {
          caseId: caseRow.id,
          guildId: message.guildId,
          phase,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    })
    .catch(async (error: unknown): Promise<AnalysisResult> => {
      const reason = `Analysis unavailable: ${error instanceof Error ? error.message : String(error)}`;
      logger.warn('Honeybot analysis failed', {
        caseId: caseRow.id,
        guildId: message.guildId,
        error: reason,
      });
      const failedAnalysis: AnalysisResult = {
        confidence: 0,
        reason,
        shouldPunish: false,
        evidence: [
          {
            type: 'classifier',
            matched: false,
            score: 0,
            summary: reason,
            metadata: { verdict: 'needs_review', source: 'analysis_failure' },
          },
        ],
      };
      await dependencies.caseStore
        .saveAnalysis(caseRow.id, failedAnalysis)
        .catch(() => undefined);
      return failedAnalysis;
    });
  logger.info('Honeybot analysis complete', {
    caseId: caseRow.id,
    guildId: message.guildId,
    confidence: analysis.confidence,
    shouldPunish: analysis.shouldPunish,
  });
  await upsertReviewIfConfigured(
    message,
    caseRow.id,
    guildConfig,
    dependencies,
    {
      status: 'Analysis complete; awaiting moderator review.',
      reason: analysis.reason,
      duplicateChannelIds,
      triggerMessageDeleted,
      preventionAppliedAtMs,
      analysis,
    },
  );

  if (guildConfig.reviewBypassEnabled && analysis.shouldPunish) {
    const punishment = guildConfig.policies.punishment;
    const auditReason = honeybotAuditReason({
      caseId: caseRow.id,
      triggerType,
      decisionSource: 'review-bypass',
      confidence: analysis.confidence,
      actorId: null,
    });
    if (guildConfig.punishmentDmNotify) {
      await dmPunishedUser({
        member,
        caseId: caseRow.id,
        action: punishment.actionType,
        reason: analysis.reason,
        auditReason,
        caseStore: dependencies.caseStore,
        storage: dependencies.storage,
      });
    }
    await dependencies.moderationQueue.enqueue(message.guildId, () =>
      applyPolicy(member, punishment, auditReason),
    );
    await dependencies.caseStore.resolve(
      caseRow.id,
      'punished',
      punishment.actionType,
      null,
      analysis.reason,
    );
    await upsertReviewIfConfigured(
      message,
      caseRow.id,
      guildConfig,
      dependencies,
      {
        status: 'Auto-punished by review bypass.',
        reason: analysis.reason,
        duplicateChannelIds,
        triggerMessageDeleted,
        preventionAppliedAtMs,
        analysis,
      },
    );
  }
}

async function deleteCrosschannelMessages(
  triggerMessage: Message<true>,
  duplicateMessages: DuplicateMessageRef[],
) {
  const deletedMessageIds: string[] = [];
  const seen = new Set<string>();
  for (const duplicate of duplicateMessages) {
    if (seen.has(duplicate.messageId)) continue;
    seen.add(duplicate.messageId);
    const deleted = await attempt(
      'delete duplicate cross-channel message',
      () => deleteDuplicateMessage(triggerMessage, duplicate),
    );
    if (deleted) deletedMessageIds.push(duplicate.messageId);
  }
  return deletedMessageIds;
}

async function deleteDuplicateMessage(
  triggerMessage: Message<true>,
  duplicate: DuplicateMessageRef,
) {
  if (duplicate.messageId === triggerMessage.id) {
    return deleteMessage(triggerMessage);
  }

  const channel = await triggerMessage.guild.channels
    .fetch(duplicate.channelId)
    .catch(() => null);
  if (!channel?.isTextBased()) return false;

  const message = await channel.messages
    .fetch(duplicate.messageId)
    .catch(() => null);
  if (!message?.inGuild()) return false;

  return deleteMessage(message);
}

async function attachmentDataUrl(
  attachment: {
    contentType: string | null;
    storageKey: string | null;
  },
  storage: FileStorage,
) {
  if (!attachment.storageKey || !attachment.contentType?.startsWith('image/')) {
    return undefined;
  }
  const bytes = await storage.read(attachment.storageKey).catch(() => null);
  return bytes
    ? `data:${attachment.contentType};base64,${bytes.toString('base64')}`
    : undefined;
}

function analysisProgressStatus(
  phase: 'matches' | 'embeddings' | 'classifier',
) {
  switch (phase) {
    case 'matches':
      return 'Fast match signals recorded; deeper analysis still running.';
    case 'embeddings':
      return 'Embedding signals recorded; classifier still running.';
    case 'classifier':
      return 'Classifier signal recorded; additional signals may still be running.';
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
  const channel = await message.guild.channels.fetch(
    guildConfig.moderationChannelId,
  );
  if (!channel?.isTextBased()) return;

  const attachments = await dependencies.caseStore.listCaseAttachments(caseId);
  const triggerType =
    message.channelId ===
    guildConfig.honeypotChannelIds.find((id) => id === message.channelId)
      ? 'honeypot'
      : 'crosschannel';
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
    prevention:
      guildConfig.policies[
        triggerType === 'honeypot'
          ? 'honeypot_prevention'
          : 'crosschannel_prevention'
      ],
    punishment: guildConfig.policies.punishment,
    preventionApplied: true,
    preventionAppliedAtMs: state.preventionAppliedAtMs,
    triggerMessageDeleted: state.triggerMessageDeleted,
    analysis: state.analysis,
  };
  const caseRow = await dependencies.caseStore.getCase(caseId);

  if (caseRow?.reviewMessageId && 'messages' in channel) {
    const existing = await channel.messages
      .fetch(caseRow.reviewMessageId)
      .catch(() => null);
    if (existing) {
      await existing.edit(caseReviewEdit(payload));
      return;
    }
  }

  const reviewMessage = await channel.send(caseReviewMessage(payload));
  await dependencies.caseStore.setReviewMessage(
    caseId,
    reviewMessage.channelId,
    reviewMessage.id,
  );
}

async function attempt<T>(label: string, operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    logger.warn(`Failed to ${label}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
