import {
  and,
  count,
  eq,
  gte,
  isNull,
  like,
  max,
  type SQL,
} from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import packageJson from '../../package.json' with { type: 'json' };
import type { Db } from '../db/database.js';
import {
  caseEvidence,
  cases,
  knownImages,
  knownTexts,
} from '../db/schema.js';
import type { ModelPurpose } from '../domain/types.js';
import type { FairQueue, QueueStats } from '../queues/fairQueue.js';
import type { ModelStore } from './modelStore.js';

const modelPurposes = [
  'text_classifier',
  'image_classifier',
  'text_embeddings',
  'image_embeddings',
] as const satisfies readonly ModelPurpose[];

export type HoneybotInfo = {
  version: string;
  revision: string | null;
  startedAt: Date;
  discordLatencyMs: number;
  guildCount: number;
  monitoredChannelCount: number;
  corpus: { texts: number; images: number; missingEmbeddings: number };
  cases: { last24Hours: number; last7Days: number; retained: number };
  models: Array<{
    purpose: ModelPurpose;
    provider: string;
    modelId: string | null;
    ready: boolean;
  }>;
  diagnostics: {
    failedAnalysesLast24Hours: number;
    lastCorpusUpdate: Date | null;
    memoryRssBytes: number;
    modelQueue: QueueStats;
    moderationQueue: QueueStats;
  };
};

export async function collectHoneybotInfo(input: {
  db: Db;
  modelStore: ModelStore;
  modelQueue: FairQueue;
  moderationQueue: FairQueue;
  guildId: string;
  guildCount: number;
  monitoredChannelCount: number;
  discordLatencyMs: number;
  now?: Date;
}): Promise<HoneybotInfo> {
  const now = input.now ?? new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);

  const [
    corpusTexts,
    corpusImages,
    textsMissingEmbeddings,
    imagesMissingEmbeddings,
    casesLast24Hours,
    casesLast7Days,
    retainedCases,
    failedAnalyses,
    lastTextUpdate,
    lastImageUpdate,
    models,
  ] = await Promise.all([
    countRows(input.db, knownTexts, eq(knownTexts.status, 'approved')),
    countRows(input.db, knownImages, eq(knownImages.status, 'approved')),
    countRows(
      input.db,
      knownTexts,
      and(
        eq(knownTexts.status, 'approved'),
        isNull(knownTexts.embeddingVectorJson),
      ),
    ),
    countRows(
      input.db,
      knownImages,
      and(
        eq(knownImages.status, 'approved'),
        isNull(knownImages.embeddingVectorJson),
      ),
    ),
    countRows(input.db, cases, gte(cases.createdAt, oneDayAgo.toISOString())),
    countRows(
      input.db,
      cases,
      gte(cases.createdAt, sevenDaysAgo.toISOString()),
    ),
    countRows(input.db, cases),
    countRows(
      input.db,
      caseEvidence,
      and(
        gte(caseEvidence.createdAt, oneDayAgo.toISOString()),
        like(caseEvidence.metadataJson, '%"source":"analysis_failure"%'),
      ),
    ),
    latestUpdate(input.db, knownTexts.updatedAt, knownTexts),
    latestUpdate(input.db, knownImages.updatedAt, knownImages),
    Promise.all(
      modelPurposes.map(async (purpose) => {
        const model = await input.modelStore.get(input.guildId, purpose);
        return {
          purpose,
          provider: model.provider,
          modelId: model.modelId,
          ready: Boolean(model.modelId && model.apiKey),
        };
      }),
    ),
  ]);

  return {
    version: process.env.HONEYBOT_VERSION ?? packageJson.version,
    revision: process.env.HONEYBOT_REVISION ?? null,
    startedAt: new Date(now.getTime() - process.uptime() * 1_000),
    discordLatencyMs: Math.max(0, Math.round(input.discordLatencyMs)),
    guildCount: input.guildCount,
    monitoredChannelCount: input.monitoredChannelCount,
    corpus: {
      texts: corpusTexts,
      images: corpusImages,
      missingEmbeddings: textsMissingEmbeddings + imagesMissingEmbeddings,
    },
    cases: {
      last24Hours: casesLast24Hours,
      last7Days: casesLast7Days,
      retained: retainedCases,
    },
    models,
    diagnostics: {
      failedAnalysesLast24Hours: failedAnalyses,
      lastCorpusUpdate: newestDate(lastTextUpdate, lastImageUpdate),
      memoryRssBytes: process.memoryUsage().rss,
      modelQueue: input.modelQueue.stats(),
      moderationQueue: input.moderationQueue.stats(),
    },
  };
}

async function countRows(
  db: Db,
  table: SQLiteTable,
  where?: SQL<unknown>,
) {
  const query = db.select({ value: count() }).from(table);
  const row = where ? await query.where(where).get() : await query.get();
  return row?.value ?? 0;
}

async function latestUpdate(
  db: Db,
  column: typeof knownTexts.updatedAt | typeof knownImages.updatedAt,
  table: typeof knownTexts | typeof knownImages,
) {
  const row = await db.select({ value: max(column) }).from(table).get();
  return row?.value ? new Date(row.value) : null;
}

function newestDate(left: Date | null, right: Date | null) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}
