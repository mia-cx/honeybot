import {
  RESTJSONErrorCodes,
  type Client,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import {
  caseReviewUncertainMessage,
  caseReviewUncertainUpdate,
} from '../interactions/caseReviewUi.js';
import { logger } from '../logger.js';
import type { CaseStore, RecoveredUncertainCase } from './caseStore.js';

type RecoverySummary = {
  updated: number;
  reposted: number;
  skipped: number;
  failed: number;
};

export async function refreshRecoveredCaseReviews(
  client: Client<true>,
  caseStore: Pick<CaseStore, 'setReviewMessage'>,
  uncertainCases: readonly RecoveredUncertainCase[],
): Promise<RecoverySummary> {
  const summary: RecoverySummary = {
    updated: 0,
    reposted: 0,
    skipped: 0,
    failed: 0,
  };

  for (const recovered of uncertainCases) {
    if (!recovered.reviewChannelId) {
      summary.skipped += 1;
      logger.warn('Cannot surface recovered case without a review channel', {
        caseId: recovered.caseId,
        guildId: recovered.guildId,
      });
      continue;
    }

    try {
      const guild = client.guilds.cache.get(recovered.guildId);
      if (!guild)
        throw new Error('Guild is not available to the Discord client');

      const channel = await guild.channels.fetch(recovered.reviewChannelId);
      if (!hasMessageHistory(channel))
        throw new Error('Review channel is unavailable or not text-based');

      const existing = await fetchExistingReview(
        channel,
        recovered.reviewMessageId,
      );
      if (existing) {
        await existing.edit(
          caseReviewUncertainUpdate(existing.components, {
            caseId: recovered.caseId,
          }),
        );
        summary.updated += 1;
        continue;
      }

      const replacement = await channel.send(
        caseReviewUncertainMessage({ caseId: recovered.caseId }),
      );
      await caseStore.setReviewMessage(
        recovered.caseId,
        replacement.channelId,
        replacement.id,
      );
      summary.reposted += 1;
    } catch (error) {
      summary.failed += 1;
      logger.error('Failed to surface recovered uncertain case', {
        caseId: recovered.caseId,
        guildId: recovered.guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

function hasMessageHistory(
  channel: Awaited<ReturnType<Client<true>['channels']['fetch']>>,
): channel is TextBasedChannel & { messages: TextBasedChannel['messages'] } {
  return Boolean(channel?.isTextBased() && 'messages' in channel);
}

async function fetchExistingReview(
  channel: TextBasedChannel & { messages: TextBasedChannel['messages'] },
  messageId: string | null,
): Promise<Message | null> {
  if (!messageId) return null;
  try {
    return await channel.messages.fetch(messageId);
  } catch (error) {
    if (isUnknownMessageError(error)) return null;
    throw error;
  }
}

function isUnknownMessageError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === RESTJSONErrorCodes.UnknownMessage
  );
}
