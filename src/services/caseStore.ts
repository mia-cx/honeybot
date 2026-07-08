import { randomUUID } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { caseAttachments, caseEvidence, caseEvents, caseMessages, cases, knownImages, knownTexts } from '../db/schema.js';
import type { AnalysisResult, CaseStatus, EvidenceItem, TriggerType } from '../domain/types.js';
import { normalizeText, textHash } from '../utils/fingerprints.js';
import type { FileStorage, StoredFile } from '../storage/fileStorage.js';
import type { Message } from 'discord.js';

const caseId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-', 16);

export class CaseStore {
  constructor(
    private readonly db: Db,
    private readonly storage: FileStorage,
  ) {}

  async getOrCreateCase(input: { guildId: string; userId: string; triggerType: TriggerType; reason: string }) {
    const existing = await this.db
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.guildId, input.guildId),
          eq(cases.userId, input.userId),
          eq(cases.triggerType, input.triggerType),
          eq(cases.status, 'pending_review'),
        ),
      )
      .get();

    if (existing) return existing;

    const now = new Date().toISOString();
    const created = {
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
    };

    await this.db.insert(cases).values(created);
    await this.addEvent(created.id, 'triggered', 'bot', null, input.reason, input);
    return created;
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

    const caseMessage = inserted[0] ?? (await this.db.select().from(caseMessages).where(eq(caseMessages.messageId, message.id)).get());
    if (!caseMessage) throw new Error('Failed to persist case message');

    const storedAttachments = [] as Array<typeof caseAttachments.$inferSelect>;
    for (const attachment of message.attachments.values()) {
      let stored: StoredFile | null = null;
      try {
        stored = await this.storage.saveFromUrl(attachment.url, [message.guildId, caseId], attachment.name ?? `${attachment.id}.bin`);
      } catch {
        // Keep metadata even if Discord CDN download fails.
      }

      const [row] = await this.db
        .insert(caseAttachments)
        .values({
          caseId,
          caseMessageId: caseMessage.id,
          discordAttachmentId: attachment.id,
          name: attachment.name ?? null,
          originalUrl: attachment.url,
          reviewAttachmentUrl: null,
          contentType: attachment.contentType ?? null,
          sizeBytes: stored?.sizeBytes ?? attachment.size,
          sha256: stored?.sha256 ?? null,
          perceptualHash: null,
          storageKey: stored?.storageKey ?? null,
          createdAt: now,
        })
        .returning();
      if (row) storedAttachments.push(row);
    }

    return { caseMessage, attachments: storedAttachments };
  }

  async markMessageDeleted(messageId: string) {
    await this.db.update(caseMessages).set({ deleted: 1 }).where(eq(caseMessages.messageId, messageId));
  }

  async getCase(caseId: string) {
    return this.db.select().from(cases).where(eq(cases.id, caseId)).get();
  }

  async getCaseByReviewMessage(guildId: string, messageId: string) {
    return this.db.select().from(cases).where(and(eq(cases.guildId, guildId), eq(cases.reviewMessageId, messageId))).get();
  }

  async getCaseBySourceMessage(messageId: string) {
    const caseMessage = await this.db.select().from(caseMessages).where(eq(caseMessages.messageId, messageId)).get();
    return caseMessage ? this.getCase(caseMessage.caseId) : undefined;
  }

  async listCaseAttachments(caseId: string) {
    return this.db.select().from(caseAttachments).where(eq(caseAttachments.caseId, caseId));
  }

  async listCaseMessages(caseId: string) {
    return this.db.select().from(caseMessages).where(eq(caseMessages.caseId, caseId));
  }

  async saveAnalysis(caseId: string, analysis: AnalysisResult) {
    const now = new Date().toISOString();
    for (const item of analysis.evidence) {
      await this.addEvidence(caseId, item);
    }
    await this.db
      .update(cases)
      .set({ evidenceSummaryJson: JSON.stringify(analysis), reason: analysis.reason, updatedAt: now })
      .where(eq(cases.id, caseId));
    await this.addEvent(caseId, 'evidence_recorded', 'bot', null, analysis.reason, { confidence: analysis.confidence });
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

  async resolve(caseId: string, status: CaseStatus, actionTaken: string | null, actorId: string | null, reason: string) {
    const now = new Date().toISOString();
    await this.db.update(cases).set({ status, actionTaken, reason, updatedAt: now }).where(eq(cases.id, caseId));
    await this.addEvent(caseId, status, actorId ? 'user' : 'bot', actorId, reason, { actionTaken });
  }

  async setReviewMessage(caseId: string, channelId: string, messageId: string) {
    await this.db.update(cases).set({ reviewChannelId: channelId, reviewMessageId: messageId, updatedAt: new Date().toISOString() }).where(eq(cases.id, caseId));
  }

  async dismissAndDeleteCase(caseId: string, actorId: string, reason: string) {
    const attachments = await this.listCaseAttachments(caseId);
    await this.addEvent(caseId, 'dismissed', 'user', actorId, reason, { deletedCase: true });
    for (const attachment of attachments) await this.storage.remove(attachment.storageKey);

    await this.db.delete(caseAttachments).where(eq(caseAttachments.caseId, caseId));
    await this.db.delete(caseMessages).where(eq(caseMessages.caseId, caseId));
    await this.db.delete(caseEvidence).where(eq(caseEvidence.caseId, caseId));
    await this.db.delete(knownTexts).where(and(eq(knownTexts.sourceCaseId, caseId), eq(knownTexts.status, 'pending')));
    await this.db.delete(knownImages).where(and(eq(knownImages.sourceCaseId, caseId), eq(knownImages.status, 'pending')));
    await this.db.delete(cases).where(eq(cases.id, caseId));
  }

  async promoteCaseToGlobalKnownScams(caseId: string, actorId: string) {
    const caseRow = await this.getCase(caseId);
    if (!caseRow) return null;

    const [messages, attachments] = await Promise.all([this.listCaseMessages(caseId), this.listCaseAttachments(caseId)]);
    const now = new Date().toISOString();
    const scamReason = caseRow.reason ?? `Promoted from Honeybot case ${caseId}`;
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
        .where(and(eq(knownTexts.textHash, message.textHash), eq(knownTexts.scope, 'global'), eq(knownTexts.status, 'approved')))
        .get();
      if (existing) {
        textSkipped += 1;
        continue;
      }
      await this.db.insert(knownTexts).values({
        id: randomUUID(),
        normalizedText: message.normalizedContent,
        textHash: message.textHash,
        embeddingProvider: null,
        embeddingModel: null,
        embeddingDimensions: null,
        embeddingVectorJson: null,
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
        .where(and(eq(knownImages.sha256, attachment.sha256), eq(knownImages.scope, 'global'), eq(knownImages.status, 'approved')))
        .get();
      if (existing) {
        imageSkipped += 1;
        continue;
      }
      await this.db.insert(knownImages).values({
        id: randomUUID(),
        sha256: attachment.sha256,
        perceptualHash: attachment.perceptualHash,
        storageKey: attachment.storageKey,
        embeddingProvider: null,
        embeddingModel: null,
        embeddingDimensions: null,
        embeddingVectorJson: null,
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
    await this.addEvent(caseId, 'known_scam_promoted', 'user', actorId, 'Promoted case evidence to global known scams', result);
    return result;
  }

  async addEvent(caseId: string, eventType: string, actorType: 'bot' | 'user', actorId: string | null, reason: string | null, metadata: unknown) {
    await this.db.insert(caseEvents).values({
      caseId,
      eventType,
      actorType,
      actorId,
      reason,
      metadataJson: JSON.stringify(metadata ?? {}),
      createdAt: new Date().toISOString(),
    });
  }

  async findKnownTextByHash(guildId: string, hash: string) {
    return this.db
      .select()
      .from(knownTexts)
      .where(and(eq(knownTexts.textHash, hash), eq(knownTexts.status, 'approved'), inArray(knownTexts.scope, ['global', 'guild'])))
      .then((rows) => rows.find((row) => row.scope === 'global' || row.guildId === guildId) ?? null);
  }

  async findKnownImageBySha(guildId: string, sha: string) {
    return this.db
      .select()
      .from(knownImages)
      .where(and(eq(knownImages.sha256, sha), eq(knownImages.status, 'approved'), inArray(knownImages.scope, ['global', 'guild'])))
      .then((rows) => rows.find((row) => row.scope === 'global' || row.guildId === guildId) ?? null);
  }
}
