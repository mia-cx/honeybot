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
  applyPolicyForUser,
  applyPolicyWithBestEffortDm,
  hasBypass,
  honeybotAuditReason,
  requireAppliedPolicy,
} from '../services/moderation.js';
import type { CaseStore } from '../services/caseStore.js';
import type { EvidenceAnalyzer } from '../services/evidenceAnalyzer.js';
import type { FairQueue } from '../queues/fairQueue.js';
import type { FileStorage } from '../storage/fileStorage.js';
import type {
  AnalysisResult,
  GuildConfig,
  PolicyApplicationOutcome,
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
  const caseRow = await dependencies.caseStore.getOrCreateCase(
    {
      guildId: message.guildId,
      userId: message.author.id,
      triggerType,
      reason: moderationReason,
    },
    { reusePending: policy.actionType === 'log' },
  );
  const persisted = await dependencies.caseStore.attachMessage(
    caseRow.id,
    message,
  );

  const preventionAuditReason = honeybotAuditReason({
    caseId: caseRow.id,
    triggerType,
    decisionSource: 'prevention',
    confidence: null,
    actorId: null,
  });

  const preventionResult = await dependencies.moderationQueue.enqueue(
    message.guildId,
    () =>
      applyPolicyForUser(
        message.guild,
        message.author.id,
        policy,
        preventionAuditReason,
      ),
  );
  await dependencies.caseStore.addEvent(
    caseRow.id,
    preventionResult.applied ? 'prevention_applied' : 'prevention_not_applied',
    'bot',
    null,
    preventionResult.applied ? moderationReason : preventionResult.detail,
    { policy },
  );
  const preventionOutcome: PolicyApplicationOutcome = preventionResult.applied
    ? { ...preventionResult, appliedAtMs: Date.now() }
    : { ...preventionResult, attemptedAtMs: Date.now() };

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

  const processedAttachments = await persisted.processedAttachments;
  const cachedAttachments = await Promise.all(
    processedAttachments.map(async (attachment): Promise<CachedAttachment> => ({
      id: attachment.discordAttachmentId,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.sizeBytes,
      url: attachment.originalUrl,
      proxyUrl: attachment.reviewAttachmentUrl ?? attachment.originalUrl,
      dataUrl:
        (await attachmentDataUrl(attachment, dependencies.storage)) ?? null,
      sha256: attachment.sha256,
      storageKey: attachment.storageKey,
    })),
  );
  const cached = dependencies.messageCache.cache(
    message,
    triggerType === 'honeypot' ? 'honeypot' : 'crosschannel',
    cachedAttachments,
  );

  await upsertReviewIfConfigured(
    message,
    caseRow.id,
    guildConfig,
    dependencies,
    {
      status: preventionOutcome.applied
        ? 'Prevention applied; analysis starting.'
        : 'Prevention was not applied; analysis starting.',
      reason: moderationReason,
      duplicateChannelIds,
      triggerMessageDeleted,
      preventionOutcome,
      analysis: null,
      punishmentReady: false,
    },
  );

  if (
    preventionOutcome.applied &&
    (policy.actionType === 'kick' || policy.actionType === 'ban')
  ) {
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
        preventionOutcome,
        analysis: null,
        punishmentReady: false,
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
          preventionOutcome,
          analysis: result,
          punishmentReady: false,
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
      preventionOutcome,
      analysis,
      punishmentReady: true,
    },
  );

  const latestCase = await dependencies.caseStore.getCase(caseRow.id);
  if (latestCase?.status !== 'pending_review') return;

  if (guildConfig.reviewBypassEnabled && analysis.shouldPunish) {
    const punishment = guildConfig.policies.punishment;
    const auditReason = honeybotAuditReason({
      caseId: caseRow.id,
      triggerType,
      decisionSource: 'review-bypass',
      confidence: analysis.confidence,
      actorId: null,
    });
    const claimed = await dependencies.caseStore.claimOperation(
      caseRow.id,
      'punish',
      null,
      punishment.actionType,
    );
    if (!claimed) return;
    let mutationStarted = false;
    let applyResult;
    try {
      applyResult = requireAppliedPolicy(
        await dependencies.moderationQueue.enqueue(message.guildId, () =>
          applyPolicyWithBestEffortDm({
            guild: message.guild,
            userId: message.author.id,
            policy: punishment,
            reason: auditReason,
            dm: guildConfig.punishmentDmNotify
              ? {
                  caseId: caseRow.id,
                  reason: analysis.reason,
                  auditReason,
                  caseStore: dependencies.caseStore,
                  storage: dependencies.storage,
                }
              : null,
            onMutationStarted: () => {
              mutationStarted = true;
            },
          }),
        ),
      );
    } catch (error) {
      if (mutationStarted) {
        const uncertain = await dependencies.caseStore.markOperationUncertain(
          caseRow.id,
          'punish',
          null,
          error,
        );
        if (!uncertain) throw error;
        logger.error('Auto-punishment outcome requires reconciliation', {
          caseId: caseRow.id,
          guildId: message.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
        await upsertReviewIfConfigured(
          message,
          caseRow.id,
          guildConfig,
          dependencies,
          {
            status: 'punishment_uncertain',
            reason:
              'Discord may have applied the automatic punishment before reporting a failure. Verify the user state and reconcile the case.',
            duplicateChannelIds,
            triggerMessageDeleted,
            preventionOutcome,
            analysis,
            punishmentReady: true,
          },
        );
        return;
      }

      await dependencies.caseStore.failOperation(
        caseRow.id,
        'punish',
        null,
        error,
      );
      logger.warn('Honeybot auto-punishment failed', {
        caseId: caseRow.id,
        guildId: message.guildId,
        error: error instanceof Error ? error.message : String(error),
      });
      await upsertReviewIfConfigured(
        message,
        caseRow.id,
        guildConfig,
        dependencies,
        {
          status: 'Auto-punishment failed; awaiting moderator review.',
          reason:
            error instanceof Error ? error.message : 'Auto-punishment failed',
          duplicateChannelIds,
          triggerMessageDeleted,
          preventionOutcome,
          analysis,
          punishmentReady: true,
        },
      );
      return;
    }
    try {
      const completed = await dependencies.caseStore.completeOperation(
        caseRow.id,
        'punish',
        punishment.actionType,
        null,
        analysis.reason,
      );
      if (!completed)
        throw new Error('Auto-punishment operation state changed unexpectedly');
    } catch (error) {
      const uncertain = await dependencies.caseStore.markOperationUncertain(
        caseRow.id,
        'punish',
        null,
        error,
      );
      if (!uncertain) throw error;
      logger.error('Auto-punishment outcome requires reconciliation', {
        caseId: caseRow.id,
        guildId: message.guildId,
        error: error instanceof Error ? error.message : String(error),
      });
      await upsertReviewIfConfigured(
        message,
        caseRow.id,
        guildConfig,
        dependencies,
        {
          status: 'punishment_uncertain',
          reason:
            'Auto-punishment reached Discord but its result could not be persisted. Verify the user state and reconcile the case.',
          duplicateChannelIds,
          triggerMessageDeleted,
          preventionOutcome,
          analysis,
          punishmentReady: true,
        },
      );
      return;
    }
    await dependencies.caseStore.addEvent(
      caseRow.id,
      'punishment_applied',
      'bot',
      null,
      analysis.reason,
      { applyResult },
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
        preventionOutcome,
        analysis,
        punishmentReady: true,
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
    preventionOutcome: PolicyApplicationOutcome;
    analysis: AnalysisResult | null;
    punishmentReady: boolean;
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
    preventionOutcome: state.preventionOutcome,
    triggerMessageDeleted: state.triggerMessageDeleted,
    analysis: state.analysis,
    punishmentReady: state.punishmentReady,
  };
  const caseRow = await dependencies.caseStore.getCase(caseId);

  if (caseRow?.reviewMessageId && 'messages' in channel) {
    const existing = await channel.messages
      .fetch(caseRow.reviewMessageId)
      .catch(() => null);
    if (existing) {
      await existing.edit(caseReviewEdit(payload, existing.components));
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
