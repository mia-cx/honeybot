import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  caseEvidence,
  cases,
  knownImages,
  knownTexts,
} from '../src/db/schema.js';
import { FairQueue } from '../src/queues/fairQueue.js';
import { collectHoneybotInfo } from '../src/services/info.js';
import { ModelStore } from '../src/services/modelStore.js';
import { testDatabase, testModelDefaults } from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Honeybot info', () => {
  it('collects deployment, corpus, case, model, and queue stats', async () => {
    vi.stubEnv('HONEYBOT_VERSION', '1.2.3');
    vi.stubEnv('HONEYBOT_REVISION', '1234567890abcdef');
    vi.spyOn(process, 'uptime').mockReturnValue(60);
    const database = testDatabase();
    const now = new Date('2026-08-22T08:00:00Z');
    const recent = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
    const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000).toISOString();

    await database.db.insert(knownTexts).values({
      id: 'text',
      normalizedText: 'known scam',
      textHash: 'hash',
      embeddingProvider: 'openrouter',
      embeddingModel: 'embed',
      embeddingDimensions: 2,
      embeddingVectorJson: '[1,0]',
      description: 'Known scam',
      scamReason: 'Test',
      scope: 'global',
      status: 'approved',
      createdAt: recent,
      updatedAt: recent,
    });
    await database.db.insert(knownImages).values({
      id: 'image',
      sha256: 'sha',
      storageKey: 'image.png',
      description: 'Known scam image',
      scamReason: 'Test',
      scope: 'global',
      status: 'approved',
      createdAt: recent,
      updatedAt: recent,
    });
    await database.db.insert(cases).values([
      caseRow('recent', recent),
      caseRow('old', old),
    ]);
    await database.db.insert(caseEvidence).values({
      caseId: 'recent',
      evidenceType: 'classifier',
      matched: 0,
      score: 0,
      summary: 'Analysis unavailable',
      metadataJson: '{"source":"analysis_failure"}',
      createdAt: recent,
    });

    const queue = new FairQueue({
      name: 'test',
      globalLimit: 10,
      perGroupLimit: 10,
      windowMs: 1_000,
    });
    const info = await collectHoneybotInfo({
      db: database.db,
      modelStore: new ModelStore(database.db, testModelDefaults()),
      modelQueue: queue,
      moderationQueue: queue,
      guildId: 'guild',
      guildCount: 3,
      monitoredChannelCount: 1,
      discordLatencyMs: 41.6,
      now,
    });

    expect(info).toMatchObject({
      version: '1.2.3',
      revision: '1234567890abcdef',
      startedAt: new Date('2026-08-22T07:59:00Z'),
      discordLatencyMs: 42,
      guildCount: 3,
      monitoredChannelCount: 1,
      corpus: { texts: 1, images: 1, missingEmbeddings: 1 },
      cases: { last24Hours: 1, last7Days: 1, retained: 2 },
      diagnostics: {
        failedAnalysesLast24Hours: 1,
        lastCorpusUpdate: new Date(recent),
        modelQueue: { active: 0, queued: 0 },
      },
    });
    expect(info.models).toHaveLength(4);
    expect(info.models.every(({ ready }) => ready)).toBe(true);
    database.sqlite.close();
  });

  it('reports active and queued jobs without exposing queue internals', async () => {
    const queue = new FairQueue({
      name: 'test',
      globalLimit: 10,
      perGroupLimit: 10,
      windowMs: 1_000,
    });
    let finish: (() => void) | undefined;
    const first = queue.enqueue(
      'guild',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const second = queue.enqueue('guild', async () => undefined);

    expect(queue.stats()).toEqual({ active: 1, queued: 1 });
    finish?.();
    await Promise.all([first, second]);
    expect(queue.stats()).toEqual({ active: 0, queued: 0 });
  });
});

function caseRow(id: string, createdAt: string) {
  return {
    id,
    guildId: 'guild',
    userId: `user-${id}`,
    triggerType: 'honeypot',
    status: 'pending_review',
    evidenceSummaryJson: '{}',
    createdAt,
    updatedAt: createdAt,
  };
}
