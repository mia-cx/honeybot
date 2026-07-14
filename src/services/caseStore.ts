import { randomUUID } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
} from 'drizzle-orm';
import type { Db } from '../db/database.js';
import {
  caseAttachments,
  caseEvidence,
  caseEvents,
  caseMessages,
  cases,
  knownImages,
  knownTexts,
} from '../db/schema.js';
import type {
  AnalysisResult,
  CaseStatus,
  EvidenceItem,
  ProximalKnownScam,
  ProximalKnownScamImage,
  TriggerType,
} from '../domain/types.js';
import type { EmbeddingResult, ScamEmbedder } from './embeddings.js';
import {
  jaccard,
  normalizeText,
  shingles,
  textHash,
} from '../utils/fingerprints.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_CASE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type FileStorage,
  type StoredFile,
} from '../storage/fileStorage.js';
import type { Message } from 'discord.js';
import { FairQueue } from '../queues/fairQueue.js';
import { resolveImageContentType } from '../storage/imageNormalization.js';
import { logger } from '../logger.js';

const caseId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-',
  16,
);

const MAX_QUEUED_ATTACHMENTS_GLOBAL = MAX_ATTACHMENTS_PER_CASE * 2;
const ATTACHMENT_RETRY_DELAY_MS = 1_000;

const attachmentQueueDefaults = {
  name: 'attachments',
  globalLimit: Number.MAX_SAFE_INTEGER,
  perGroupLimit: Number.MAX_SAFE_INTEGER,
  windowMs: 1_000,
  maxPendingGlobal: MAX_QUEUED_ATTACHMENTS_GLOBAL,
  maxPendingPerGroup: MAX_ATTACHMENTS_PER_CASE,
  logFailures: false,
} as const;

const caseOperationTransitions = {
  punish: {
    from: 'pending_review',
    claimed: 'punishment_pending',
    uncertain: 'punishment_uncertain',
    to: 'punished',
  },
  dismiss: {
    from: 'pending_review',
    claimed: 'dismissal_pending',
    uncertain: 'dismissal_uncertain',
    to: 'dismissed',
  },
  revert_punishment: {
    from: 'punished',
    claimed: 'punishment_revert_pending',
    uncertain: 'punishment_revert_uncertain',
    to: 'pending_review',
  },
  revert_dismissal: {
    from: 'dismissed',
    claimed: 'dismissal_revert_pending',
    uncertain: 'dismissal_revert_uncertain',
    to: 'pending_review',
  },
} as const satisfies Record<
  string,
  {
    from: CaseStatus;
    claimed: CaseStatus;
    uncertain: CaseStatus;
    to: CaseStatus;
  }
>;

export type CaseOperation = keyof typeof caseOperationTransitions;

type CaseOperationTransition = (typeof caseOperationTransitions)[CaseOperation];

function operationTransitions() {
  return Object.entries(caseOperationTransitions) as Array<
    [CaseOperation, CaseOperationTransition]
  >;
}

const claimedCaseStatuses = operationTransitions().map(
  ([, transition]) => transition.claimed,
);
const uncertainCaseStatuses = operationTransitions().map(
  ([, transition]) => transition.uncertain,
);
const activeCaseStatuses = [
  'pending_review',
  ...claimedCaseStatuses,
  ...uncertainCaseStatuses,
] satisfies CaseStatus[];

export type RecoveredUncertainCase = {
  caseId: string;
  guildId: string;
  reviewChannelId: string | null;
  reviewMessageId: string | null;
};

function operationTransitionForStatus(
  status: string,
  state: 'claimed' | 'uncertain',
) {
  return operationTransitions().find(
    ([, transition]) => transition[state] === status,
  );
}

type CaseAttachmentRow = typeof caseAttachments.$inferSelect;

class AttachmentProcessingCancelledError extends Error {}

export class CaseStore {
  private readonly attachmentJobs = new Map<number, Promise<void>>();
  private readonly attachmentWaiters = new Map<
    number,
    {
      promise: Promise<CaseAttachmentRow>;
      resolve: (row: CaseAttachmentRow) => void;
      reject: (error: unknown) => void;
    }
  >();
  private retryingPendingAttachments = false;
  private pendingAttachmentRetryRequested = false;
  private pendingAttachmentRetryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly storage: FileStorage,
    private readonly embedder?: ScamEmbedder,
    private readonly attachmentQueue = new FairQueue(attachmentQueueDefaults),
  ) {}

  async getOrCreateCase(
    input: {
      guildId: string;
      userId: string;
      triggerType: TriggerType;
      reason: string;
    },
    options: { reusePending?: boolean } = {},
  ) {
    return this.db.transaction(
      (tx) => {
        if (options.reusePending ?? true) {
          const existing = tx
            .select()
            .from(cases)
            .where(
              and(
                eq(cases.guildId, input.guildId),
                eq(cases.userId, input.userId),
                eq(cases.triggerType, input.triggerType),
                inArray(cases.status, activeCaseStatuses),
              ),
            )
            .orderBy(desc(cases.updatedAt))
            .get();

          if (existing) return existing;
        }

        const now = new Date().toISOString();
        const created = tx
          .insert(cases)
          .values({
            id: caseId(),
            guildId: input.guildId,
            userId: input.userId,
            triggerType: input.triggerType,
            status: 'pending_review' as CaseStatus,
            actionTaken: null,
            reason: input.reason,
            evidenceSummaryJson: '{}',
            reviewChannelId: null,
            reviewMessageId: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();

        tx.insert(caseEvents)
          .values(
            caseEventValues(
              created.id,
              'triggered',
              'bot',
              null,
              input.reason,
              input,
            ),
          )
          .run();
        return created;
      },
      { behavior: 'immediate' },
    );
  }

  async attachMessage(caseId: string, message: Message<true>) {
    const normalizedContent = normalizeText(message.content);
    const now = new Date().toISOString();
    const inserted = await this.db
      .insert(caseMessages)
      .values({
        caseId,
        messageId: message.id,
        channelId: message.channelId,
        authorId: message.author.id,
        content: message.content,
        normalizedContent,
        textHash: textHash(message.content),
        deleted: 0,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();

    const caseMessage =
      inserted[0] ??
      (await this.db
        .select()
        .from(caseMessages)
        .where(eq(caseMessages.messageId, message.id))
        .get());
    if (!caseMessage) throw new Error('Failed to persist case message');

    const attachmentMetadata: CaseAttachmentRow[] = [];
    const attachmentStorage: Array<Promise<CaseAttachmentRow>> = [];
    let admittedAttachments = 0;
    for (const attachment of message.attachments.values()) {
      const attachmentName = attachment.name ?? `${attachment.id}.bin`;
      const eligibleForProcessing =
        resolveImageContentType(attachment.contentType, attachmentName) !==
          null &&
        admittedAttachments < MAX_ATTACHMENTS_PER_MESSAGE &&
        attachment.size <= MAX_ATTACHMENT_BYTES;
      const row = this.db.transaction(
        (tx) => {
          const occupiedSlots = eligibleForProcessing
            ? tx
                .select({ processingSlot: caseAttachments.processingSlot })
                .from(caseAttachments)
                .where(
                  and(
                    eq(caseAttachments.caseId, caseId),
                    isNotNull(caseAttachments.processingSlot),
                  ),
                )
                .all()
            : [];
          const processingSlot =
            eligibleForProcessing &&
            occupiedSlots.length < MAX_ATTACHMENTS_PER_CASE
              ? Math.max(
                  0,
                  ...occupiedSlots.map((item) => item.processingSlot ?? 0),
                ) + 1
              : null;

          return tx
            .insert(caseAttachments)
            .values({
              caseId,
              caseMessageId: caseMessage.id,
              discordAttachmentId: attachment.id,
              name: attachment.name ?? null,
              originalUrl: attachment.url,
              reviewAttachmentUrl: null,
              contentType: attachment.contentType ?? null,
              sizeBytes: attachment.size,
              sha256: null,
              perceptualHash: null,
              storageKey: null,
              processingSlot,
              processingState: processingSlot === null ? null : 'pending',
              createdAt: now,
            })
            .returning()
            .get();
        },
        { behavior: 'immediate' },
      );

      const storageTask =
        row.processingSlot === null
          ? Promise.resolve(row)
          : this.queueAttachmentStorage(message.guildId, row);

      attachmentMetadata.push(row);
      attachmentStorage.push(storageTask);
      if (row.processingSlot !== null) admittedAttachments += 1;
    }

    return {
      caseMessage,
      attachments: attachmentMetadata,
      processedAttachments: Promise.all(attachmentStorage),
    };
  }

  async recoverInterruptedAttachments() {
    const interrupted = await this.db
      .select({ attachment: caseAttachments, guildId: cases.guildId })
      .from(caseAttachments)
      .innerJoin(cases, eq(caseAttachments.caseId, cases.id))
      .where(eq(caseAttachments.processingState, 'pending'));

    for (const { attachment, guildId } of interrupted) {
      await this.queueAttachmentStorage(guildId, attachment);
    }
    return interrupted.length;
  }

  private queueAttachmentStorage(
    guildId: string,
    row: CaseAttachmentRow,
  ): Promise<CaseAttachmentRow> {
    const waiting = this.attachmentWaiterFor(row.id);
    if (!this.attachmentJobs.has(row.id))
      this.startAttachmentStorage(guildId, row);
    return waiting.promise;
  }

  private attachmentWaiterFor(rowId: number) {
    const existing = this.attachmentWaiters.get(rowId);
    if (existing) return existing;

    let resolve!: (row: CaseAttachmentRow) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<CaseAttachmentRow>(
      (resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      },
    );
    const waiting = { promise, resolve, reject };
    this.attachmentWaiters.set(rowId, waiting);
    return waiting;
  }

  private startAttachmentStorage(guildId: string, row: CaseAttachmentRow) {
    if (this.attachmentJobs.has(row.id)) return true;

    const queued = this.attachmentQueue.tryEnqueue(row.caseId, async () => {
      let stored: StoredFile;
      try {
        stored = await this.storage.saveFromUrl(
          row.originalUrl,
          [guildId, row.caseId],
          row.name ?? `${row.discordAttachmentId}.bin`,
          {
            contentType: row.contentType,
            expectedSizeBytes: row.sizeBytes,
          },
        );
      } catch (error) {
        return this.persistAttachmentFailure(row, error);
      }
      return this.persistStoredAttachment(row, stored);
    });
    if (!queued) return false;

    const waiting = this.attachmentWaiterFor(row.id);
    const storageTask = queued
      .then(waiting.resolve, waiting.reject)
      .finally(() => {
        this.attachmentJobs.delete(row.id);
        this.attachmentWaiters.delete(row.id);
        if (this.attachmentWaiters.size > 0)
          this.requestPendingAttachmentRetry();
      });

    this.attachmentJobs.set(row.id, storageTask);
    return true;
  }

  private async persistStoredAttachment(
    row: CaseAttachmentRow,
    stored: StoredFile,
  ): Promise<CaseAttachmentRow> {
    while (true) {
      try {
        const [updated] = await this.db
          .update(caseAttachments)
          .set({
            name: stored.fileName,
            contentType: stored.contentType,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            storageKey: stored.storageKey,
            processingState: 'stored',
          })
          .where(eq(caseAttachments.id, row.id))
          .returning();
        if (updated) return updated;

        await this.removeUncommittedAttachment(row, stored.storageKey);
        throw new AttachmentProcessingCancelledError(
          'Attachment was removed before storage completed',
        );
      } catch (error) {
        if (error instanceof AttachmentProcessingCancelledError) throw error;
        logger.warn('Failed to persist stored attachment', {
          caseId: row.caseId,
          discordAttachmentId: row.discordAttachmentId,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.waitForAttachmentRetry();
      }
    }
  }

  private async removeUncommittedAttachment(
    row: CaseAttachmentRow,
    storageKey: string,
  ) {
    while (true) {
      try {
        await this.storage.remove(storageKey);
        return;
      } catch (error) {
        logger.warn('Failed to remove uncommitted attachment file', {
          caseId: row.caseId,
          discordAttachmentId: row.discordAttachmentId,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.waitForAttachmentRetry();
      }
    }
  }

  private async persistAttachmentFailure(
    row: CaseAttachmentRow,
    error: unknown,
  ): Promise<CaseAttachmentRow> {
    while (true) {
      try {
        const failed = this.db.transaction(
          (tx) => {
            const updated = tx
              .update(caseAttachments)
              .set({ processingState: 'failed' })
              .where(eq(caseAttachments.id, row.id))
              .returning()
              .get();
            if (!updated) return null;

            tx.insert(caseEvents)
              .values(
                caseEventValues(
                  row.caseId,
                  'attachment_storage_failed',
                  'bot',
                  null,
                  'Attachment retained as metadata only',
                  {
                    discordAttachmentId: row.discordAttachmentId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                ),
              )
              .run();
            return updated;
          },
          { behavior: 'immediate' },
        );
        if (failed) return failed;
        throw new AttachmentProcessingCancelledError(
          'Attachment was removed before failure could be recorded',
        );
      } catch (updateError) {
        if (updateError instanceof AttachmentProcessingCancelledError)
          throw updateError;
        logger.warn('Failed to persist attachment storage failure', {
          caseId: row.caseId,
          discordAttachmentId: row.discordAttachmentId,
          error:
            updateError instanceof Error
              ? updateError.message
              : String(updateError),
        });
        await this.waitForAttachmentRetry();
      }
    }
  }

  private waitForAttachmentRetry() {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ATTACHMENT_RETRY_DELAY_MS);
    });
  }

  private requestPendingAttachmentRetry() {
    this.pendingAttachmentRetryRequested = true;
    if (!this.retryingPendingAttachments)
      void this.retryPendingAttachmentStorage();
  }

  private schedulePendingAttachmentRetry() {
    if (this.pendingAttachmentRetryTimer) return;
    this.pendingAttachmentRetryTimer = setTimeout(() => {
      this.pendingAttachmentRetryTimer = null;
      this.requestPendingAttachmentRetry();
    }, ATTACHMENT_RETRY_DELAY_MS);
  }

  private async retryPendingAttachmentStorage() {
    if (this.retryingPendingAttachments) return;
    this.retryingPendingAttachments = true;

    try {
      while (this.pendingAttachmentRetryRequested) {
        this.pendingAttachmentRetryRequested = false;
        const activeIds = [...this.attachmentJobs.keys()];
        const pending = await this.db
          .select({ attachment: caseAttachments, guildId: cases.guildId })
          .from(caseAttachments)
          .innerJoin(cases, eq(caseAttachments.caseId, cases.id))
          .where(
            activeIds.length > 0
              ? and(
                  eq(caseAttachments.processingState, 'pending'),
                  notInArray(caseAttachments.id, activeIds),
                )
              : eq(caseAttachments.processingState, 'pending'),
          )
          .orderBy(caseAttachments.id)
          .limit(MAX_QUEUED_ATTACHMENTS_GLOBAL);

        for (const { attachment, guildId } of pending) {
          void this.startAttachmentStorage(guildId, attachment);
        }
      }
    } catch (error) {
      logger.error('Failed to retry pending attachment storage', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.schedulePendingAttachmentRetry();
    } finally {
      this.retryingPendingAttachments = false;
      if (this.pendingAttachmentRetryRequested)
        void this.retryPendingAttachmentStorage();
    }
  }

  async markMessageDeleted(messageId: string) {
    await this.db
      .update(caseMessages)
      .set({ deleted: 1 })
      .where(eq(caseMessages.messageId, messageId));
  }

  async getCase(caseId: string) {
    return this.db.select().from(cases).where(eq(cases.id, caseId)).get();
  }

  async getCaseByReviewMessage(guildId: string, messageId: string) {
    return this.db
      .select()
      .from(cases)
      .where(
        and(eq(cases.guildId, guildId), eq(cases.reviewMessageId, messageId)),
      )
      .get();
  }

  async getCaseBySourceMessage(messageId: string) {
    const caseMessage = await this.db
      .select()
      .from(caseMessages)
      .where(eq(caseMessages.messageId, messageId))
      .get();
    return caseMessage ? this.getCase(caseMessage.caseId) : undefined;
  }

  async listCaseAttachments(caseId: string) {
    return this.db
      .select()
      .from(caseAttachments)
      .where(eq(caseAttachments.caseId, caseId));
  }

  async listCaseMessages(caseId: string) {
    return this.db
      .select()
      .from(caseMessages)
      .where(eq(caseMessages.caseId, caseId));
  }

  async saveAnalysis(caseId: string, analysis: AnalysisResult) {
    const now = new Date().toISOString();
    for (const item of analysis.evidence) {
      await this.addEvidence(caseId, item);
    }
    await this.db
      .update(cases)
      .set({
        evidenceSummaryJson: JSON.stringify(analysis),
        reason: analysis.reason,
        updatedAt: now,
      })
      .where(eq(cases.id, caseId));
    await this.addEvent(
      caseId,
      'evidence_recorded',
      'bot',
      null,
      analysis.reason,
      { confidence: analysis.confidence },
    );
  }

  async addEvidence(caseId: string, item: EvidenceItem) {
    await this.db.insert(caseEvidence).values({
      caseId,
      evidenceType: item.type,
      matched: item.matched ? 1 : 0,
      score: item.score,
      summary: item.summary,
      metadataJson: JSON.stringify(item.metadata ?? {}),
      createdAt: new Date().toISOString(),
    });
  }

  async resolve(
    caseId: string,
    status: CaseStatus,
    actionTaken: string | null,
    actorId: string | null,
    reason: string,
  ) {
    const now = new Date().toISOString();
    await this.db
      .update(cases)
      .set({
        status,
        actionTaken,
        operationActionTaken: null,
        operationDispatchedAt: null,
        reason,
        updatedAt: now,
      })
      .where(eq(cases.id, caseId));
    await this.addEvent(
      caseId,
      status,
      actorId ? 'user' : 'bot',
      actorId,
      reason,
      { actionTaken },
    );
  }

  async recoverInterruptedOperations() {
    return this.db.transaction(
      (tx) => {
        const interruptedCases = tx
          .select()
          .from(cases)
          .where(inArray(cases.status, claimedCaseStatuses))
          .all();
        let recoveredCount = 0;

        for (const caseRow of interruptedCases) {
          const entry = operationTransitionForStatus(caseRow.status, 'claimed');
          if (!entry) {
            throw new Error(
              `Missing recovery transition for case status: ${caseRow.status}`,
            );
          }
          const [operation, transition] = entry;
          const dispatched = caseRow.operationDispatchedAt !== null;
          const updated = tx
            .update(cases)
            .set({
              status: dispatched ? transition.uncertain : transition.from,
              operationActionTaken: dispatched
                ? caseRow.operationActionTaken
                : null,
              operationDispatchedAt: dispatched
                ? caseRow.operationDispatchedAt
                : null,
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(cases.id, caseRow.id),
                eq(cases.status, transition.claimed),
              ),
            )
            .returning()
            .get();
          if (!updated) continue;

          tx.insert(caseEvents)
            .values(
              caseEventValues(
                caseRow.id,
                dispatched
                  ? 'operation_outcome_uncertain'
                  : 'operation_recovered',
                'bot',
                null,
                dispatched
                  ? `Interrupted dispatched operation requires manual review: ${operation}`
                  : `Interrupted operation restored before Discord dispatch: ${operation}`,
                {
                  operation,
                  previousStatus: transition.from,
                  possibleStatus: transition.to,
                  dispatched,
                },
              ),
            )
            .run();
          recoveredCount += 1;
        }

        return recoveredCount;
      },
      { behavior: 'immediate' },
    );
  }

  async listUncertainCaseReviews(): Promise<RecoveredUncertainCase[]> {
    return this.db
      .select({
        caseId: cases.id,
        guildId: cases.guildId,
        reviewChannelId: cases.reviewChannelId,
        reviewMessageId: cases.reviewMessageId,
      })
      .from(cases)
      .where(inArray(cases.status, uncertainCaseStatuses))
      .all();
  }

  async claimOperation(
    caseId: string,
    operation: CaseOperation,
    actorId: string | null,
    operationActionTaken: string | null = null,
  ) {
    const transition = caseOperationTransitions[operation];
    return this.db.transaction(
      (tx) => {
        const updated = tx
          .update(cases)
          .set({
            status: transition.claimed,
            operationActionTaken,
            operationDispatchedAt: null,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(cases.id, caseId), eq(cases.status, transition.from)))
          .returning()
          .get();
        if (!updated) return null;
        tx.insert(caseEvents)
          .values(
            caseEventValues(
              caseId,
              'operation_claimed',
              actorId ? 'user' : 'bot',
              actorId,
              `Claimed case operation: ${operation}`,
              { operation, operationActionTaken, ...transition },
            ),
          )
          .run();
        return updated;
      },
      { behavior: 'immediate' },
    );
  }

  async markOperationDispatched(
    caseId: string,
    operation: CaseOperation,
    actorId: string | null,
  ) {
    const transition = caseOperationTransitions[operation];
    return this.db.transaction(
      (tx) => {
        const dispatchedAt = new Date().toISOString();
        const updated = tx
          .update(cases)
          .set({ operationDispatchedAt: dispatchedAt, updatedAt: dispatchedAt })
          .where(
            and(
              eq(cases.id, caseId),
              eq(cases.status, transition.claimed),
              isNull(cases.operationDispatchedAt),
            ),
          )
          .returning()
          .get();
        if (!updated) return null;
        tx.insert(caseEvents)
          .values(
            caseEventValues(
              caseId,
              'operation_dispatched',
              actorId ? 'user' : 'bot',
              actorId,
              `Dispatching Discord mutation for case operation: ${operation}`,
              { operation },
            ),
          )
          .run();
        return updated;
      },
      { behavior: 'immediate' },
    );
  }

  async completeOperation(
    caseId: string,
    operation: CaseOperation,
    actionTaken: string | null,
    actorId: string | null,
    reason: string,
  ) {
    const transition = caseOperationTransitions[operation];
    return this.db.transaction(
      (tx) => {
        const updated = tx
          .update(cases)
          .set({
            status: transition.to,
            actionTaken,
            operationActionTaken: null,
            operationDispatchedAt: null,
            reason,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(eq(cases.id, caseId), eq(cases.status, transition.claimed)),
          )
          .returning()
          .get();
        if (!updated) return null;
        tx.insert(caseEvents)
          .values(
            caseEventValues(
              caseId,
              transition.to,
              actorId ? 'user' : 'bot',
              actorId,
              reason,
              { actionTaken, operation, previousStatus: transition.from },
            ),
          )
          .run();
        return updated;
      },
      { behavior: 'immediate' },
    );
  }

  async failOperation(
    caseId: string,
    operation: CaseOperation,
    actorId: string | null,
    error: unknown,
  ) {
    const transition = caseOperationTransitions[operation];
    const message = error instanceof Error ? error.message : String(error);
    return this.db.transaction(
      (tx) => {
        const updated = tx
          .update(cases)
          .set({
            status: transition.from,
            operationActionTaken: null,
            operationDispatchedAt: null,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(eq(cases.id, caseId), eq(cases.status, transition.claimed)),
          )
          .returning()
          .get();
        if (!updated) return null;
        tx.insert(caseEvents)
          .values(
            caseEventValues(
              caseId,
              'operation_failed',
              actorId ? 'user' : 'bot',
              actorId,
              `Case operation failed: ${operation}`,
              { operation, error: message, restoredStatus: transition.from },
            ),
          )
          .run();
        return updated;
      },
      { behavior: 'immediate' },
    );
  }

  async markOperationUncertain(
    caseId: string,
    operation: CaseOperation,
    actorId: string | null,
    error: unknown,
  ) {
    const transition = caseOperationTransitions[operation];
    const message = error instanceof Error ? error.message : String(error);
    return this.db.transaction(
      (tx) => {
        const updated = tx
          .update(cases)
          .set({
            status: transition.uncertain,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(eq(cases.id, caseId), eq(cases.status, transition.claimed)),
          )
          .returning()
          .get();
        if (!updated) return null;
        tx.insert(caseEvents)
          .values(
            caseEventValues(
              caseId,
              'operation_outcome_uncertain',
              actorId ? 'user' : 'bot',
              actorId,
              `Case operation may have completed externally and requires reconciliation: ${operation}`,
              {
                operation,
                error: message,
                previousStatus: transition.from,
                possibleStatus: transition.to,
              },
            ),
          )
          .run();
        return updated;
      },
      { behavior: 'immediate' },
    );
  }

  async reconcileOperation(
    caseId: string,
    sideEffectApplied: boolean,
    actorId: string,
  ) {
    return this.db.transaction(
      (tx) => {
        const caseRow = tx
          .select()
          .from(cases)
          .where(eq(cases.id, caseId))
          .get();
        if (!caseRow) return null;
        const entry = operationTransitionForStatus(caseRow.status, 'uncertain');
        if (!entry) return null;

        const [operation, transition] = entry;
        const status = sideEffectApplied ? transition.to : transition.from;
        const actionTaken = sideEffectApplied
          ? caseRow.operationActionTaken
          : caseRow.actionTaken;
        const reason = `Interrupted ${operation} operation manually reconciled as ${sideEffectApplied ? 'applied' : 'not applied'}`;
        const updated = tx
          .update(cases)
          .set({
            status,
            actionTaken,
            operationActionTaken: null,
            operationDispatchedAt: null,
            reason,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(eq(cases.id, caseId), eq(cases.status, transition.uncertain)),
          )
          .returning()
          .get();
        if (!updated) return null;

        tx.insert(caseEvents)
          .values(
            caseEventValues(
              caseId,
              'operation_reconciled',
              'user',
              actorId,
              reason,
              {
                operation,
                sideEffectApplied,
                previousStatus: transition.from,
                completedStatus: transition.to,
                reconciledStatus: status,
              },
            ),
          )
          .run();
        return updated;
      },
      { behavior: 'immediate' },
    );
  }

  async setReviewMessage(caseId: string, channelId: string, messageId: string) {
    await this.db
      .update(cases)
      .set({
        reviewChannelId: channelId,
        reviewMessageId: messageId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(cases.id, caseId));
  }

  async dismissAndDeleteCase(caseId: string, actorId: string, reason: string) {
    const attachments = await this.listCaseAttachments(caseId);
    await this.addEvent(caseId, 'dismissed', 'user', actorId, reason, {
      deletedCase: true,
    });
    for (const attachment of attachments)
      await this.storage.remove(attachment.storageKey);

    await this.db
      .delete(caseAttachments)
      .where(eq(caseAttachments.caseId, caseId));
    await this.db.delete(caseMessages).where(eq(caseMessages.caseId, caseId));
    await this.db.delete(caseEvidence).where(eq(caseEvidence.caseId, caseId));
    await this.db
      .delete(knownTexts)
      .where(
        and(
          eq(knownTexts.sourceCaseId, caseId),
          eq(knownTexts.status, 'pending'),
        ),
      );
    await this.db
      .delete(knownImages)
      .where(
        and(
          eq(knownImages.sourceCaseId, caseId),
          eq(knownImages.status, 'pending'),
        ),
      );
    await this.db.delete(cases).where(eq(cases.id, caseId));
  }

  async promoteCaseToGlobalKnownScams(caseId: string, actorId: string) {
    const caseRow = await this.getCase(caseId);
    if (!caseRow) return null;

    const [messages, attachments] = await Promise.all([
      this.listCaseMessages(caseId),
      this.listCaseAttachments(caseId),
    ]);
    const now = new Date().toISOString();
    const scamReason =
      caseRow.reason ?? `Promoted from Honeybot case ${caseId}`;
    const description = `Global known scam from Honeybot case ${caseId}`;
    let textAdded = 0;
    let textSkipped = 0;
    let imageAdded = 0;
    let imageSkipped = 0;

    for (const message of messages) {
      if (!message.textHash || !message.normalizedContent.trim()) {
        textSkipped += 1;
        continue;
      }
      const existing = await this.db
        .select()
        .from(knownTexts)
        .where(
          and(
            eq(knownTexts.textHash, message.textHash),
            eq(knownTexts.scope, 'global'),
            eq(knownTexts.status, 'approved'),
          ),
        )
        .get();
      if (existing) {
        textSkipped += 1;
        continue;
      }
      const embedding = await this.embedder
        ?.embedText(caseRow.guildId, message.normalizedContent)
        .catch(() => null);
      if (!embedding) {
        textSkipped += 1;
        continue;
      }
      await this.db.insert(knownTexts).values({
        id: randomUUID(),
        normalizedText: message.normalizedContent,
        textHash: message.textHash,
        embeddingProvider: embedding.provider,
        embeddingModel: embedding.model,
        embeddingDimensions: embedding.dimensions,
        embeddingVectorJson: JSON.stringify(embedding.vector),
        description,
        scamReason,
        sourceCaseId: caseId,
        sourceDiscordMessageId: message.messageId,
        approvedBy: actorId,
        scope: 'global',
        guildId: null,
        status: 'approved',
        createdAt: now,
        updatedAt: now,
      });
      textAdded += 1;
    }

    for (const attachment of attachments) {
      if (!attachment.sha256 || !attachment.storageKey) {
        imageSkipped += 1;
        continue;
      }
      const existing = await this.db
        .select()
        .from(knownImages)
        .where(
          and(
            eq(knownImages.sha256, attachment.sha256),
            eq(knownImages.scope, 'global'),
            eq(knownImages.status, 'approved'),
          ),
        )
        .get();
      if (existing) {
        imageSkipped += 1;
        continue;
      }
      const dataUrl = await this.imageDataUrl(attachment.storageKey).catch(
        () => null,
      );
      const embedding = dataUrl
        ? await this.embedder
            ?.embedImage(caseRow.guildId, {
              contentType: attachment.contentType,
              name: attachment.name,
              url: attachment.originalUrl,
              storageKey: attachment.storageKey,
              dataUrl,
            })
            .catch(() => null)
        : null;
      if (!embedding) {
        imageSkipped += 1;
        continue;
      }
      await this.db.insert(knownImages).values({
        id: randomUUID(),
        sha256: attachment.sha256,
        perceptualHash: attachment.perceptualHash,
        storageKey: attachment.storageKey,
        embeddingProvider: embedding.provider,
        embeddingModel: embedding.model,
        embeddingDimensions: embedding.dimensions,
        embeddingVectorJson: JSON.stringify(embedding.vector),
        description,
        scamReason,
        sourceCaseId: caseId,
        sourceDiscordAttachmentId: attachment.discordAttachmentId,
        approvedBy: actorId,
        scope: 'global',
        guildId: null,
        status: 'approved',
        createdAt: now,
        updatedAt: now,
      });
      imageAdded += 1;
    }

    const result = { textAdded, textSkipped, imageAdded, imageSkipped };
    await this.addEvent(
      caseId,
      'known_scam_promoted',
      'user',
      actorId,
      'Promoted case evidence to global known scams',
      result,
    );
    return result;
  }

  async addEvent(
    caseId: string,
    eventType: string,
    actorType: 'bot' | 'user',
    actorId: string | null,
    reason: string | null,
    metadata: unknown,
  ) {
    await this.db
      .insert(caseEvents)
      .values(
        caseEventValues(
          caseId,
          eventType,
          actorType,
          actorId,
          reason,
          metadata,
        ),
      );
  }

  async findKnownTextByHash(guildId: string, hash: string) {
    return this.db
      .select()
      .from(knownTexts)
      .where(
        and(
          eq(knownTexts.textHash, hash),
          eq(knownTexts.status, 'approved'),
          inArray(knownTexts.scope, ['global', 'guild']),
        ),
      )
      .then(
        (rows) =>
          rows.find(
            (row) =>
              hasCorpusEmbedding(row) &&
              (row.scope === 'global' || row.guildId === guildId),
          ) ?? null,
      );
  }

  async findKnownImageBySha(guildId: string, sha: string) {
    return this.db
      .select()
      .from(knownImages)
      .where(
        and(
          eq(knownImages.sha256, sha),
          eq(knownImages.status, 'approved'),
          inArray(knownImages.scope, ['global', 'guild']),
        ),
      )
      .then(
        (rows) =>
          rows.find(
            (row) =>
              hasCorpusEmbedding(row) &&
              (row.scope === 'global' || row.guildId === guildId),
          ) ?? null,
      );
  }

  async listKnownCorpus(
    guildId: string,
    options: {
      page?: number;
      pageSize?: number;
      type?: 'all' | 'text' | 'image';
    } = {},
  ) {
    const pageSize = options.pageSize ?? 5;
    const page = Math.max(1, options.page ?? 1);
    const type = options.type ?? 'all';
    const items: KnownCorpusItem[] = [];

    if (type === 'all' || type === 'text') {
      const textRows = await this.db
        .select()
        .from(knownTexts)
        .where(
          and(
            eq(knownTexts.status, 'approved'),
            inArray(knownTexts.scope, ['global', 'guild']),
          ),
        )
        .then((rows) =>
          rows.filter(
            (row) =>
              hasCorpusEmbedding(row) &&
              (row.scope === 'global' || row.guildId === guildId),
          ),
        );
      items.push(
        ...textRows.map((row) => ({
          kind: 'text' as const,
          id: row.id,
          scope: row.scope,
          guildId: row.guildId,
          description: row.description,
          scamReason: row.scamReason,
          sourceCaseId: row.sourceCaseId,
          embeddingProvider: row.embeddingProvider,
          embeddingModel: row.embeddingModel,
          embeddingDimensions: row.embeddingDimensions,
          preview: row.normalizedText,
          createdAt: row.createdAt,
        })),
      );
    }

    if (type === 'all' || type === 'image') {
      const imageRows = await this.db
        .select()
        .from(knownImages)
        .where(
          and(
            eq(knownImages.status, 'approved'),
            inArray(knownImages.scope, ['global', 'guild']),
          ),
        )
        .then((rows) =>
          rows.filter(
            (row) =>
              hasCorpusEmbedding(row) &&
              (row.scope === 'global' || row.guildId === guildId),
          ),
        );
      items.push(
        ...imageRows.map((row) => ({
          kind: 'image' as const,
          id: row.id,
          scope: row.scope,
          guildId: row.guildId,
          description: row.description,
          scamReason: row.scamReason,
          sourceCaseId: row.sourceCaseId,
          embeddingProvider: row.embeddingProvider,
          embeddingModel: row.embeddingModel,
          embeddingDimensions: row.embeddingDimensions,
          preview: row.storageKey,
          createdAt: row.createdAt,
        })),
      );
    }

    const sorted = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    return {
      items: sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
      page: safePage,
      pageSize,
      total,
      totalPages,
      type,
    };
  }

  async findProximalKnownScams(
    cached: { guildId: string; normalizedContent: string },
    options: {
      maxScams?: number;
      maxImages?: number;
      textEmbedding?: EmbeddingResult | null;
      imageEmbeddings?: EmbeddingResult[];
    } = {},
  ): Promise<ProximalKnownScam[]> {
    const maxScams = options.maxScams ?? 3;
    const maxImages = options.maxImages ?? 10;
    const inputShingles = shingles(cached.normalizedContent);

    const textRows = await this.db
      .select()
      .from(knownTexts)
      .where(
        and(
          eq(knownTexts.status, 'approved'),
          inArray(knownTexts.scope, ['global', 'guild']),
        ),
      )
      .then((rows) =>
        rows.filter(
          (row) =>
            hasCorpusEmbedding(row) &&
            (row.scope === 'global' || row.guildId === cached.guildId),
        ),
      );

    const candidates = new Map<string, ProximalCandidate>();
    for (const row of textRows) {
      const embeddingScore = cosineForStoredEmbedding(
        options.textEmbedding,
        row.embeddingProvider,
        row.embeddingModel,
        row.embeddingDimensions,
        row.embeddingVectorJson,
      );
      const fuzzyScore = inputShingles.size
        ? jaccard(inputShingles, shingles(row.normalizedText))
        : 0;
      const score = Math.max(embeddingScore ?? 0, fuzzyScore);
      if (score <= 0) continue;
      candidates.set(`text:${row.id}`, {
        id: row.id,
        sourceCaseId: row.sourceCaseId,
        score,
        source:
          embeddingScore !== null && embeddingScore >= fuzzyScore
            ? 'text_embedding'
            : 'text_fuzzy',
        description: row.description,
        scamReason: row.scamReason,
        normalizedText: row.normalizedText,
        imageRow: null,
      });
    }

    const imageEmbeddings = options.imageEmbeddings ?? [];
    if (imageEmbeddings.length > 0) {
      const imageRows = await this.db
        .select()
        .from(knownImages)
        .where(
          and(
            eq(knownImages.status, 'approved'),
            inArray(knownImages.scope, ['global', 'guild']),
          ),
        )
        .then((rows) =>
          rows.filter(
            (row) =>
              hasCorpusEmbedding(row) &&
              (row.scope === 'global' || row.guildId === cached.guildId),
          ),
        );
      for (const row of imageRows) {
        const score = Math.max(
          ...imageEmbeddings.map(
            (embedding) =>
              cosineForStoredEmbedding(
                embedding,
                row.embeddingProvider,
                row.embeddingModel,
                row.embeddingDimensions,
                row.embeddingVectorJson,
              ) ?? 0,
          ),
        );
        if (score <= 0) continue;
        candidates.set(`image:${row.id}`, {
          id: row.id,
          sourceCaseId: row.sourceCaseId,
          score,
          source: 'image_embedding',
          description: row.description,
          scamReason: row.scamReason,
          normalizedText: null,
          imageRow: row,
        });
      }
    }

    const ranked = [...candidates.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxScams);

    let remainingImages = maxImages;
    const refs: ProximalKnownScam[] = [];
    for (const candidate of ranked) {
      const images = await this.imagesForCandidate(candidate, remainingImages);
      remainingImages -= images.length;
      refs.push({
        id: candidate.id,
        sourceCaseId: candidate.sourceCaseId,
        score: candidate.score,
        source: candidate.source,
        description: candidate.description,
        scamReason: candidate.scamReason,
        normalizedText: candidate.normalizedText,
        images,
      });
    }
    return refs;
  }

  private async imagesForCandidate(
    candidate: ProximalCandidate,
    limit: number,
  ): Promise<ProximalKnownScamImage[]> {
    if (limit <= 0) return [];
    if (candidate.imageRow) {
      const image = await this.knownImageToProximal(candidate.imageRow).catch(
        () => null,
      );
      return image ? [image] : [];
    }
    return candidate.sourceCaseId
      ? this.proximalImagesForCase(candidate.sourceCaseId, limit)
      : [];
  }

  private async proximalImagesForCase(
    caseId: string,
    limit: number,
  ): Promise<ProximalKnownScamImage[]> {
    const rows = await this.db
      .select()
      .from(knownImages)
      .where(
        and(
          eq(knownImages.sourceCaseId, caseId),
          eq(knownImages.status, 'approved'),
        ),
      )
      .limit(limit);
    const images: ProximalKnownScamImage[] = [];
    for (const row of rows) {
      if (!hasCorpusEmbedding(row)) continue;
      const image = await this.knownImageToProximal(row).catch(() => null);
      if (image) images.push(image);
    }
    return images;
  }

  private async knownImageToProximal(row: typeof knownImages.$inferSelect) {
    const dataUrl = await this.imageDataUrl(row.storageKey);
    return {
      id: row.id,
      storageKey: row.storageKey,
      contentType: contentTypeForStorageKey(row.storageKey),
      sizeBytes: 0,
      dataUrl,
    };
  }

  private async imageDataUrl(storageKey: string) {
    const contentType = contentTypeForStorageKey(storageKey);
    const bytes = await this.storage.read(storageKey);
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  }
}

function caseEventValues(
  caseId: string,
  eventType: string,
  actorType: 'bot' | 'user',
  actorId: string | null,
  reason: string | null,
  metadata: unknown,
) {
  return {
    caseId,
    eventType,
    actorType,
    actorId,
    reason,
    metadataJson: JSON.stringify(metadata ?? {}),
    createdAt: new Date().toISOString(),
  };
}

export type KnownCorpusItem = {
  kind: 'text' | 'image';
  id: string;
  scope: string;
  guildId: string | null;
  description: string;
  scamReason: string;
  sourceCaseId: string | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  preview: string;
  createdAt: string;
};

type ProximalCandidate = {
  id: string;
  sourceCaseId: string | null;
  score: number;
  source: NonNullable<ProximalKnownScam['source']>;
  description: string;
  scamReason: string;
  normalizedText: string | null;
  imageRow: typeof knownImages.$inferSelect | null;
};

function hasCorpusEmbedding(row: {
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingVectorJson: string | null;
}) {
  return Boolean(
    row.embeddingProvider &&
    row.embeddingModel &&
    row.embeddingDimensions &&
    row.embeddingVectorJson,
  );
}

function cosineForStoredEmbedding(
  query: EmbeddingResult | null | undefined,
  provider: string | null,
  model: string | null,
  dimensions: number | null,
  vectorJson: string | null,
) {
  if (!query || !vectorJson) return null;
  if (
    provider !== query.provider ||
    model !== query.model ||
    dimensions !== query.dimensions
  )
    return null;
  const vector = parseVector(vectorJson);
  return vector ? cosineSimilarity(query.vector, vector) : null;
}

function parseVector(json: string) {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) &&
      value.every((item) => typeof item === 'number' && Number.isFinite(item))
      ? value
      : null;
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    aMagnitude += left * left;
    bMagnitude += right * right;
  }
  if (aMagnitude === 0 || bMagnitude === 0) return 0;
  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function contentTypeForStorageKey(storageKey: string) {
  const lower = storageKey.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}
