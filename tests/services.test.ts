import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  caseAttachments,
  cases,
  caseEvents,
  caseMessages,
  knownImages,
  knownTexts,
} from '../src/db/schema.js';
import { defaultGuildConfig } from '../src/domain/defaults.js';
import { handleInteractionCreate } from '../src/events/interactionCreate.js';
import { handleMessageCreate } from '../src/events/messageCreate.js';
import { FairQueue } from '../src/queues/fairQueue.js';
import { CaseStore } from '../src/services/caseStore.js';
import {
  crosschannelCurveSvg,
  renderCrosschannelCurveImage,
} from '../src/services/crosschannelGraph.js';
import {
  crosschannelAllowedWindowSeconds,
  DuplicateDetector,
} from '../src/services/duplicateDetector.js';
import type { EmbeddingResult } from '../src/services/embeddings.js';
import {
  EvidenceAnalyzer,
  type AnalysisProgress,
} from '../src/services/evidenceAnalyzer.js';
import { MessageCache } from '../src/services/messageCache.js';
import { ModelStore } from '../src/services/modelStore.js';
import {
  isVerboseLoggingEnabled,
  loadVerboseLogging,
  setVerboseLogging,
  toggleVerboseLogging,
} from '../src/services/verbose.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_CASE,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../src/storage/fileStorage.js';
import {
  cleanupTempDirs,
  testDatabase,
  testDatabaseWithSetup,
  testModelDefaults,
} from './helpers.js';
import type { AnalysisResult } from '../src/domain/types.js';
import type { CachedMessage, ClassificationResult } from '../src/types.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

describe('MessageCache', () => {
  it('normalizes text and preserves stored attachment metadata', () => {
    const cache = new MessageCache();
    const message = fakeMessage({
      content: ' FREE   Nitro!!! ',
      attachments: [],
    });
    const cached = cache.cache(message, 'honeypot', [
      storedAttachment({ id: 'att' }),
    ]);

    expect(cached.normalizedContent).toBe('free nitro');
    expect(cached.textHash).toHaveLength(64);
    expect(cached.attachments).toEqual([
      expect.objectContaining({ id: 'att', sha256: 'sha' }),
    ]);
    expect(cache.get(message.id)).toBe(cached);
  });

  it('trims old entries after the fixed cache limit', () => {
    const cache = new MessageCache();
    for (let i = 0; i < 501; i += 1)
      cache.cache(fakeMessage({ id: `m${i}` }), 'crosschannel');

    expect(cache.get('m0')).toBeNull();
    expect(cache.get('m500')?.id).toBe('m500');
  });
});

describe('DuplicateDetector', () => {
  it('uses a normalized logistic S-curve for cross-channel windows', () => {
    const config = defaultGuildConfig();

    expect(crosschannelAllowedWindowSeconds(1, config)).toBe(0);
    expect(crosschannelAllowedWindowSeconds(2, config)).toBe(5);
    expect(crosschannelAllowedWindowSeconds(13, config)).toBeGreaterThan(1750);
    expect(crosschannelAllowedWindowSeconds(13, config)).toBeLessThan(1850);
    expect(crosschannelAllowedWindowSeconds(40, config)).toBeLessThanOrEqual(
      3600,
    );
  });

  it('renders the cross-channel curve as an image with point labels', async () => {
    const config = defaultGuildConfig();
    const svg = crosschannelCurveSvg(config);

    expect(svg).toContain('2 ≤ channels &lt; 32.5');
    expect(svg).toContain('2ch · 5s');
    expect(svg).toContain('13ch · 29m54s');
    expect(svg).toContain('fill-opacity="0.88"');

    const image = await renderCrosschannelCurveImage(config);
    expect(image.filename).toBe('honeybot-crosschannel-curve.png');
    expect(image.buffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('matches repeated content across distinct channels within the window', () => {
    const detector = new DuplicateDetector();
    const config = defaultGuildConfig({
      crosschannelChannelThreshold: 2,
      crosschannelWindowSeconds: 60,
    });

    expect(
      detector.record(
        fakeMessage({ id: 'm1', channelId: 'c1', content: 'free nitro' }),
        config,
      ),
    ).toEqual({
      matched: false,
      channelIds: ['c1'],
      messages: [{ channelId: 'c1', messageId: 'm1' }],
    });
    expect(
      detector.record(
        fakeMessage({ id: 'm2', channelId: 'c2', content: 'FREE   NITRO!!!' }),
        config,
      ),
    ).toEqual({
      matched: true,
      channelIds: ['c1', 'c2'],
      messages: [
        { channelId: 'c1', messageId: 'm1' },
        { channelId: 'c2', messageId: 'm2' },
      ],
    });
  });

  it('uses a 2-second minimum window for text-only duplicates', () => {
    const now = vi.spyOn(Date, 'now');

    expect(matchesDuplicateAfter(2_000, now)).toBe(true);
    expect(matchesDuplicateAfter(2_001, now)).toBe(false);
  });

  it('retains the configured minimum window for attachment-bearing duplicates', () => {
    const now = vi.spyOn(Date, 'now');
    const attachments: [unknown[], unknown[]] = [
      [attachment()],
      [attachment()],
    ];

    expect(matchesDuplicateAfter(5_000, now, attachments)).toBe(true);
    expect(matchesDuplicateAfter(5_001, now, attachments)).toBe(false);
  });

  it('uses the attachment window when either duplicate has attachments', () => {
    const now = vi.spyOn(Date, 'now');

    expect(matchesDuplicateAfter(4_000, now, [[attachment()], []])).toBe(true);
    expect(matchesDuplicateAfter(4_000, now, [[], [attachment()]])).toBe(true);
  });

  it('ignores disabled or empty cross-channel signals and sweeps expired entries', () => {
    const detector = new DuplicateDetector();
    const disabled = defaultGuildConfig({ crosschannelEnabled: false });
    expect(detector.record(fakeMessage({ content: 'same' }), disabled)).toEqual(
      { matched: false, channelIds: [], messages: [] },
    );

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const config = defaultGuildConfig({
      crosschannelChannelThreshold: 2,
      crosschannelWindowSeconds: 1,
    });
    detector.record(fakeMessage({ channelId: 'c1', content: 'same' }), config);
    now.mockReturnValue(3_000);
    detector.sweep(1_000);
    expect(
      detector.record(
        fakeMessage({ channelId: 'c2', content: 'same' }),
        config,
      ),
    ).toEqual({
      matched: false,
      channelIds: ['c2'],
      messages: [{ channelId: 'c2', messageId: 'message' }],
    });
  });
});

describe('handleMessageCreate', () => {
  it('reuses pending cases only when prevention is log-only', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      honeypotChannelIds: ['honey'],
      moderationChannelId: null,
    });
    config.policies.honeypot_prevention.actionType = 'log';
    config.policies.honeypot_prevention.deleteMessages = false;

    const deleted: string[] = [];
    const guild = fakeDiscordGuild(deleted);
    const first = fakeDiscordMessage({ id: 'm1', channelId: 'honey', guild });
    const second = fakeDiscordMessage({ id: 'm2', channelId: 'honey', guild });
    guild.register(first);
    guild.register(second);

    const dependencies = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      messageCache: new MessageCache(),
      duplicateDetector: new DuplicateDetector(),
      caseStore: new CaseStore(database.db, fakeStorage()),
      analyzer: {
        analyze: vi.fn(async (): Promise<AnalysisResult> => ({
          confidence: 0,
          shouldPunish: false,
          reason: 'done',
          evidence: [],
        })),
      },
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;

    await handleMessageCreate(first, dependencies);
    await handleMessageCreate(second, dependencies);

    expect(await database.db.select().from(cases)).toHaveLength(1);
    expect(await database.db.select().from(caseMessages)).toHaveLength(2);
    expect(dependencies.analyzer.analyze).toHaveBeenCalledTimes(2);

    config.policies.honeypot_prevention.actionType = 'timeout';
    const third = fakeDiscordMessage({ id: 'm3', channelId: 'honey', guild });
    guild.register(third);

    await handleMessageCreate(third, dependencies);

    expect(await database.db.select().from(cases)).toHaveLength(2);
    expect(await database.db.select().from(caseMessages)).toHaveLength(3);

    database.sqlite.close();
  });

  it.each(['timeout', 'kick', 'ban'] as const)(
    'does not send punishment DMs for %s prevention actions',
    async (action) => {
      const database = testDatabase();
      const config = defaultGuildConfig({
        honeypotChannelIds: ['honey'],
        moderationChannelId: null,
        punishmentDmNotify: true,
      });
      config.policies.honeypot_prevention.actionType = action;
      config.policies.honeypot_prevention.deleteMessages = false;

      const actions: string[] = [];
      const guild = fakeDiscordGuild([], actions);
      const message = fakeDiscordMessage({
        id: 'm1',
        channelId: 'honey',
        content: 'free nitro',
        guild,
      });
      guild.register(message);

      const dependencies = {
        configStore: { getGuildConfig: vi.fn(async () => config) },
        messageCache: new MessageCache(),
        duplicateDetector: new DuplicateDetector(),
        caseStore: new CaseStore(database.db, fakeStorage()),
        analyzer: {
          analyze: vi.fn(async () => ({
            confidence: 0,
            shouldPunish: false,
            reason: 'not a scam',
            evidence: [],
          })),
        },
        moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
        storage: fakeStorage(),
      } as any;

      await handleMessageCreate(message, dependencies);

      expect(actions).toEqual([action]);
      expect(dependencies.analyzer.analyze).toHaveBeenCalledTimes(
        action === 'timeout' ? 1 : 0,
      );
      expect(
        await database.db
          .select()
          .from(caseEvents)
          .where(inArray(caseEvents.eventType, ['dm_notified', 'failed'])),
      ).toHaveLength(0);
      database.sqlite.close();
    },
  );

  it('does not record or display unapplied prevention as successful', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      honeypotChannelIds: ['honey'],
      moderationChannelId: 'review',
      punishmentDmNotify: false,
    });
    config.policies.honeypot_prevention.actionType = 'timeout';
    config.policies.honeypot_prevention.deleteMessages = false;

    const actions: string[] = [];
    const guild = fakeDiscordGuild([], actions);
    const message = fakeDiscordMessage({
      id: 'unapplied-prevention',
      channelId: 'honey',
      guild,
    });
    guild.register(message);
    type ReviewPayload = { components: unknown[] };
    const reviewMessage = {
      id: 'review-message',
      channelId: 'review',
      components: [] as unknown[],
      edit: vi.fn(async (payload: ReviewPayload) => {
        reviewMessage.components = payload.components;
        return reviewMessage;
      }),
    };
    const reviewChannel = {
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => reviewMessage) },
      send: vi.fn(async (payload: ReviewPayload) => {
        reviewMessage.components = payload.components;
        return reviewMessage;
      }),
    };
    guild.channels.fetch.mockResolvedValue(reviewChannel);
    (guild.members.fetch as any)
      .mockResolvedValueOnce(message.member)
      .mockResolvedValueOnce(null);
    const analyzer = {
      analyze: vi.fn(async (): Promise<AnalysisResult> => ({
        confidence: 0,
        shouldPunish: false,
        reason: 'review required',
        evidence: [],
      })),
    };
    const dependencies = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      messageCache: new MessageCache(),
      duplicateDetector: new DuplicateDetector(),
      caseStore: new CaseStore(database.db, fakeStorage()),
      analyzer,
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;

    await handleMessageCreate(message, dependencies);

    expect(actions).toEqual([]);
    expect(analyzer.analyze).toHaveBeenCalledOnce();
    const reviewPayloads = [
      ...reviewChannel.send.mock.calls.map(([payload]) => payload),
      ...reviewMessage.edit.mock.calls.map(([payload]) => payload),
    ];
    expect(reviewPayloads).not.toHaveLength(0);
    for (const payload of reviewPayloads) {
      const reviewText = JSON.stringify(payload.components);
      expect(reviewText).toContain(
        'prevention was not applied: timeout could not be applied because the member is no longer in the guild',
      );
      expect(reviewText).not.toContain('was timed out until');
    }
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.eventType, 'prevention_applied')),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.eventType, 'prevention_not_applied')),
    ).toEqual([
      expect.objectContaining({
        reason:
          'timeout could not be applied because the member is no longer in the guild',
      }),
    ]);
    database.sqlite.close();
  });

  it('applies prevention before slow attachment storage completes', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      honeypotChannelIds: ['honey'],
      moderationChannelId: null,
      punishmentDmNotify: false,
    });
    config.policies.honeypot_prevention.actionType = 'ban';
    config.policies.honeypot_prevention.deleteMessages = false;

    let signalStorageStarted: () => void = () => undefined;
    const storageStarted = new Promise<void>((resolve) => {
      signalStorageStarted = resolve;
    });
    let releaseStorage: () => void = () => undefined;
    const storageGate = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });
    const storage = fakeStorage();
    storage.saveFromUrl.mockImplementation(async () => {
      signalStorageStarted();
      await storageGate;
      return {
        storageKey: 'guild/case/file.png',
        sha256: 'sha256',
        sizeBytes: 456,
        path: '/tmp/guild/case/file.png',
        contentType: 'image/png',
        fileName: 'file.png',
        normalized: false,
      };
    });
    const actions: string[] = [];
    const guild = fakeDiscordGuild([], actions);
    const message = fakeDiscordMessage({
      id: 'slow-attachment',
      channelId: 'honey',
      guild,
      attachments: [attachment({ id: 'slow' })],
    });
    guild.register(message);
    const dependencies = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      messageCache: new MessageCache(),
      duplicateDetector: new DuplicateDetector(),
      caseStore: new CaseStore(database.db, storage),
      analyzer: { analyze: vi.fn() },
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage,
    } as any;

    const handling = handleMessageCreate(message, dependencies);
    await storageStarted;
    await vi.waitFor(() => expect(actions).toEqual(['ban']));
    releaseStorage();
    await handling;

    expect(storage.saveFromUrl).toHaveBeenCalledOnce();
    expect(dependencies.analyzer.analyze).not.toHaveBeenCalled();
    database.sqlite.close();
  });

  it('deletes every duplicate message during cross-channel prevention', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({ moderationChannelId: null });
    config.policies.crosschannel_prevention.actionType = 'timeout';
    config.policies.crosschannel_prevention.deleteMessages = true;

    const deleted: string[] = [];
    const actions: string[] = [];
    const guild = fakeDiscordGuild(deleted, actions);
    const first = fakeDiscordMessage({
      id: 'm1',
      channelId: 'c1',
      content: 'free nitro',
      guild,
    });
    const second = fakeDiscordMessage({
      id: 'm2',
      channelId: 'c2',
      content: 'FREE   NITRO!!!',
      guild,
    });
    guild.register(first);
    guild.register(second);

    const dependencies = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      messageCache: new MessageCache(),
      duplicateDetector: new DuplicateDetector(),
      caseStore: new CaseStore(database.db, fakeStorage()),
      analyzer: {
        analyze: vi.fn(async (): Promise<AnalysisResult> => ({
          confidence: 0,
          shouldPunish: false,
          reason: 'done',
          evidence: [],
        })),
      },
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;

    await handleMessageCreate(first, dependencies);
    await handleMessageCreate(second, dependencies);

    expect(deleted).toEqual(['m1', 'm2']);
    expect(actions).toEqual(['timeout', 'delete:m1', 'delete:m2']);
    expect(dependencies.analyzer.analyze).toHaveBeenCalledTimes(1);
    database.sqlite.close();
  });

  it('continues auto-punishment when its DM notification fails', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      honeypotChannelIds: ['honey'],
      moderationChannelId: null,
      punishmentDmNotify: true,
      reviewBypassEnabled: true,
    });
    config.policies.honeypot_prevention.actionType = 'log';
    config.policies.honeypot_prevention.deleteMessages = false;
    config.policies.punishment.actionType = 'ban';

    const actions: string[] = [];
    const guild = fakeDiscordGuild([], actions, {
      dmError: new Error('closed'),
    });
    const message = fakeDiscordMessage({ channelId: 'honey', guild });
    guild.register(message);
    const caseStore = new CaseStore(database.db, fakeStorage());
    const dependencies = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      messageCache: new MessageCache(),
      duplicateDetector: new DuplicateDetector(),
      caseStore,
      analyzer: {
        analyze: vi.fn(async (): Promise<AnalysisResult> => ({
          confidence: 1,
          shouldPunish: true,
          reason: 'known scam',
          evidence: [],
        })),
      },
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;

    await handleMessageCreate(message, dependencies);

    expect(actions).toEqual(['ban']);
    expect(await database.db.select().from(cases)).toEqual([
      expect.objectContaining({ status: 'punished' }),
    ]);
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.eventType, 'failed')),
    ).toHaveLength(1);
    database.sqlite.close();
  });

  it('marks a failed dispatched auto-punishment uncertain', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      honeypotChannelIds: ['honey'],
      moderationChannelId: null,
      punishmentDmNotify: false,
      reviewBypassEnabled: true,
    });
    config.policies.honeypot_prevention.actionType = 'log';
    config.policies.honeypot_prevention.deleteMessages = false;
    config.policies.punishment.actionType = 'ban';

    const guild = fakeDiscordGuild([]);
    guild.members.ban.mockRejectedValueOnce(
      new Error('Discord response lost'),
    );
    const message = fakeDiscordMessage({ channelId: 'honey', guild });
    guild.register(message);
    const caseStore = new CaseStore(database.db, fakeStorage());
    const dependencies = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      messageCache: new MessageCache(),
      duplicateDetector: new DuplicateDetector(),
      caseStore,
      analyzer: {
        analyze: vi.fn(async (): Promise<AnalysisResult> => ({
          confidence: 1,
          shouldPunish: true,
          reason: 'known scam',
          evidence: [],
        })),
      },
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;

    await handleMessageCreate(message, dependencies);

    expect(guild.members.ban).toHaveBeenCalledOnce();
    expect(await database.db.select().from(cases)).toEqual([
      expect.objectContaining({
        status: 'punishment_uncertain',
        actionTaken: null,
        operationActionTaken: 'ban',
      }),
    ]);
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.eventType, 'operation_outcome_uncertain')),
    ).toHaveLength(1);
    database.sqlite.close();
  });
});

describe('case review interactions', () => {
  it('rejects moderator punishment until analysis is recorded', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      moderatorUsers: ['moderator-1'],
      punishmentDmNotify: true,
    });
    config.policies.punishment.actionType = 'ban';
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'case triggered',
    });
    const ban = vi.fn(async () => undefined);
    const guild = {
      id: 'guild',
      ownerId: 'owner',
      members: { fetch: vi.fn(), ban },
    } as any;
    const interaction = fakeCaseButtonInteraction(
      guild,
      `case:punish:${caseRow.id}`,
      'moderator-1',
    );
    const deps = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      modelStore: {},
      caseStore: store,
      db: database.db,
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;

    await handleInteractionCreate(interaction as any, deps);

    expect(ban).not.toHaveBeenCalled();
    expect(await store.getCase(caseRow.id)).toMatchObject({
      status: 'pending_review',
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Analysis is still in progress. Try again when it completes.',
      ephemeral: true,
    });
    database.sqlite.close();
  });

  it('marks a failed dispatched punishment uncertain instead of retrying it', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      moderatorUsers: ['moderator-1'],
      punishmentDmNotify: false,
    });
    config.policies.punishment.actionType = 'ban';
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'known scam',
    });
    await recordAnalysis(store, caseRow.id);
    const ban = vi.fn(async () => {
      throw new Error('Discord response lost');
    });
    const guild = {
      id: 'guild',
      ownerId: 'owner',
      members: { fetch: vi.fn(async () => null), ban },
    } as any;
    const deps = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      modelStore: {},
      caseStore: store,
      db: database.db,
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;
    const interaction = fakeCaseButtonInteraction(
      guild,
      `case:punish:${caseRow.id}`,
      'moderator-1',
    );

    await handleInteractionCreate(interaction as any, deps);

    expect(ban).toHaveBeenCalledOnce();
    expect(await store.getCase(caseRow.id)).toMatchObject({
      status: 'punishment_uncertain',
      actionTaken: null,
      operationActionTaken: 'ban',
    });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.update.mock.calls[0]?.[0])).toContain(
      `case:reconcile-applied:${caseRow.id}`,
    );
    database.sqlite.close();
  });

  it('marks a failed dispatched punishment revert uncertain', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      moderatorUsers: ['moderator-1'],
    });
    config.policies.punishment.actionType = 'ban';
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'known scam',
    });
    await recordAnalysis(store, caseRow.id);
    await store.claimOperation(caseRow.id, 'punish', 'moderator-1', 'ban');
    await store.completeOperation(
      caseRow.id,
      'punish',
      'ban',
      'moderator-1',
      'punished',
    );
    const unban = vi.fn(async () => {
      throw new Error('Discord response lost');
    });
    const guild = {
      id: 'guild',
      ownerId: 'owner',
      members: { fetch: vi.fn(async () => null), unban },
    } as any;
    const deps = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      modelStore: {},
      caseStore: store,
      db: database.db,
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;
    const interaction = fakeCaseButtonInteraction(
      guild,
      `case:revert:${caseRow.id}`,
      'moderator-1',
    );

    await handleInteractionCreate(interaction as any, deps);

    expect(unban).toHaveBeenCalledOnce();
    expect(await store.getCase(caseRow.id)).toMatchObject({
      status: 'punishment_revert_uncertain',
      actionTaken: 'ban',
      operationActionTaken: null,
    });
    expect(JSON.stringify(interaction.update.mock.calls[0]?.[0])).toContain(
      `case:reconcile-applied:${caseRow.id}`,
    );
    database.sqlite.close();
  });

  it('retries punishment after a transient member lookup failure', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      moderatorUsers: ['moderator-1'],
      punishmentDmNotify: true,
    });
    config.policies.punishment.actionType = 'ban';
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'known scam',
    });
    await recordAnalysis(store, caseRow.id);
    const ban = vi.fn(async () => undefined);
    const punishedMember = {
      id: 'user',
      guild: null as any,
      send: vi.fn(async () => undefined),
    };
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Discord unavailable'))
      .mockResolvedValueOnce(punishedMember);
    const guild = {
      id: 'guild',
      ownerId: 'owner',
      members: { fetch, ban },
    } as any;
    punishedMember.guild = guild;
    const deps = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      modelStore: {},
      caseStore: store,
      db: database.db,
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;
    const first = fakeCaseButtonInteraction(
      guild,
      `case:punish:${caseRow.id}`,
      'moderator-1',
    );
    const retry = fakeCaseButtonInteraction(
      guild,
      `case:punish:${caseRow.id}`,
      'moderator-1',
    );

    await handleInteractionCreate(first as any, deps);

    expect(ban).not.toHaveBeenCalled();
    expect(await store.getCase(caseRow.id)).toMatchObject({
      status: 'pending_review',
    });
    expect(first.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('Discord unavailable'),
      ephemeral: true,
    });

    await handleInteractionCreate(retry as any, deps);

    expect(punishedMember.send).toHaveBeenCalledOnce();
    expect(ban).toHaveBeenCalledOnce();
    expect(await store.getCase(caseRow.id)).toMatchObject({
      status: 'punished',
    });
    database.sqlite.close();
  });

  it('makes post-side-effect persistence failures explicitly reconcilable', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      moderatorUsers: ['moderator-1'],
      punishmentDmNotify: true,
    });
    config.policies.punishment.actionType = 'ban';
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'known scam',
    });
    await recordAnalysis(store, caseRow.id);
    vi.spyOn(store, 'completeOperation').mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const ban = vi.fn(async () => undefined);
    const punishedMember = {
      id: 'user',
      guild: null as any,
      send: vi.fn(async () => undefined),
    };
    const guild = {
      id: 'guild',
      ownerId: 'owner',
      members: { fetch: vi.fn(async () => punishedMember), ban },
    } as any;
    punishedMember.guild = guild;
    const deps = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      modelStore: {},
      caseStore: store,
      db: database.db,
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;
    const punish = fakeCaseButtonInteraction(
      guild,
      `case:punish:${caseRow.id}`,
      'moderator-1',
    );

    await handleInteractionCreate(punish as any, deps);

    expect(punishedMember.send).toHaveBeenCalledOnce();
    expect(ban).toHaveBeenCalledOnce();
    expect(await store.getCase(caseRow.id)).toMatchObject({
      status: 'punishment_uncertain',
      actionTaken: null,
      operationActionTaken: 'ban',
    });
    expect(JSON.stringify(punish.update.mock.calls[0]?.[0])).toContain(
      `case:reconcile-applied:${caseRow.id}`,
    );

    const reconcile = fakeCaseButtonInteraction(
      guild,
      `case:reconcile-applied:${caseRow.id}`,
      'moderator-1',
    );
    await handleInteractionCreate(reconcile as any, deps);

    expect(punishedMember.send).toHaveBeenCalledOnce();
    expect(ban).toHaveBeenCalledOnce();
    expect(await store.getCase(caseRow.id)).toMatchObject({
      status: 'punished',
      actionTaken: 'ban',
      operationActionTaken: null,
    });
    expect(reconcile.update).toHaveBeenCalledOnce();
    await expect(
      store.reconcileOperation(caseRow.id, true, 'moderator-1'),
    ).resolves.toBeNull();
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.eventType, 'operation_reconciled')),
    ).toHaveLength(1);
    database.sqlite.close();
  });

  it('keeps absent-member punishments retryable when no action was applied', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      moderatorUsers: ['moderator-1'],
      punishmentDmNotify: false,
    });
    config.policies.punishment.actionType = 'timeout';
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'departed-user',
      triggerType: 'honeypot',
      reason: 'known scam',
    });
    await recordAnalysis(store, caseRow.id);
    const guild = {
      id: 'guild',
      ownerId: 'owner',
      members: {
        fetch: vi.fn(async () => null),
      },
    } as any;
    const deps = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      modelStore: {},
      caseStore: store,
      db: database.db,
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;
    const interaction = fakeCaseButtonInteraction(
      guild,
      `case:punish:${caseRow.id}`,
      'moderator-1',
    );

    await handleInteractionCreate(interaction as any, deps);

    expect(await store.getCase(caseRow.id)).toMatchObject({
      status: 'pending_review',
      actionTaken: null,
    });
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('no longer in the guild'),
      ephemeral: true,
    });
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.eventType, 'operation_failed')),
    ).toHaveLength(1);
    database.sqlite.close();
  });

  it('applies one concurrent punishment and treats the failed DM as best-effort', async () => {
    const database = testDatabase();
    const config = defaultGuildConfig({
      moderatorUsers: ['moderator-1', 'moderator-2'],
      punishmentDmNotify: true,
    });
    config.policies.punishment.actionType = 'ban';
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'known scam',
    });
    await recordAnalysis(store, caseRow.id);
    const actions: string[] = [];
    const punishedMember = {
      id: 'user',
      guild: null as any,
      send: vi.fn(async () => Promise.reject(new Error('closed'))),
    };
    const guild = {
      id: 'guild',
      ownerId: 'owner',
      members: {
        fetch: vi.fn(async () => punishedMember),
        ban: vi.fn(async () => actions.push('ban')),
      },
    } as any;
    punishedMember.guild = guild;
    const deps = {
      configStore: { getGuildConfig: vi.fn(async () => config) },
      modelStore: {},
      caseStore: store,
      db: database.db,
      moderationQueue: { enqueue: vi.fn(async (_guildId, job) => job()) },
      storage: fakeStorage(),
    } as any;
    const first = fakeCaseButtonInteraction(
      guild,
      `case:punish:${caseRow.id}`,
      'moderator-1',
    );
    const second = fakeCaseButtonInteraction(
      guild,
      `case:punish:${caseRow.id}`,
      'moderator-2',
    );

    await Promise.all([
      handleInteractionCreate(first as any, deps),
      handleInteractionCreate(second as any, deps),
    ]);

    expect(actions).toEqual(['ban']);
    expect(
      first.update.mock.calls.length + second.update.mock.calls.length,
    ).toBe(1);
    expect(first.reply.mock.calls.length + second.reply.mock.calls.length).toBe(
      1,
    );
    expect([first, second].flatMap((item) => item.reply.mock.calls)).toEqual([
      [
        {
          content: 'Case already resolved by another moderator.',
          ephemeral: true,
        },
      ],
    ]);
    expect(await store.getCase(caseRow.id)).toMatchObject({
      status: 'punished',
    });
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.eventType, 'failed')),
    ).toHaveLength(1);
    database.sqlite.close();
  });
});

describe('FairQueue', () => {
  it('runs successful jobs and propagates failures', async () => {
    const queue = new FairQueue({
      name: 'test',
      globalLimit: 10,
      perGuildLimit: 10,
      windowMs: 1_000,
    });

    await expect(queue.enqueue('guild', async () => 'ok')).resolves.toBe('ok');
    await expect(
      queue.enqueue('guild', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('rejects work beyond configured queue capacity', async () => {
    const queue = new FairQueue({
      name: 'bounded',
      globalLimit: 10,
      perGuildLimit: 10,
      windowMs: 1_000,
      maxPendingGlobal: 1,
      maxPendingPerGuild: 1,
    });
    let release!: () => void;
    const blocked = queue.enqueue(
      'guild',
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    await expect(queue.enqueue('guild', async () => undefined)).rejects.toThrow(
      'capacity',
    );
    release();
    await blocked;
  });
});

describe('ModelStore', () => {
  it('uses bot defaults without leaking default API-key hints', async () => {
    const database = testDatabase();
    const store = new ModelStore(database.db, testModelDefaults());

    await expect(store.get('guild', 'text_classifier')).resolves.toMatchObject({
      provider: 'openrouter',
      modelId: 'text-model',
      apiKey: 'default-openrouter-key',
      apiKeyHint: null,
    });

    database.sqlite.close();
  });

  it('stores, hints, decrypts, and clears guild BYOK keys', async () => {
    const database = testDatabase();
    const store = new ModelStore(database.db, testModelDefaults());

    await store.setModel(
      'guild',
      'text_classifier',
      'openrouter',
      'override-model',
    );
    await store.setApiKey('guild', 'text_classifier', 'sk-1234567890');
    await expect(store.get('guild', 'text_classifier')).resolves.toMatchObject({
      provider: 'openrouter',
      modelId: 'override-model',
      apiKey: 'sk-1234567890',
      apiKeyHint: 'sk-1*****7890',
    });

    await store.clearApiKey('guild', 'text_classifier');
    await expect(store.get('guild', 'text_classifier')).resolves.toMatchObject({
      apiKey: 'default-openrouter-key',
      apiKeyHint: null,
    });

    database.sqlite.close();
  });

  it('ignores guild model overrides for embedding purposes', async () => {
    const database = testDatabase();
    const store = new ModelStore(database.db, testModelDefaults());

    await store.setModel(
      'guild',
      'text_embeddings',
      'custom-provider',
      'guild-embed-model',
    );
    await expect(store.get('guild', 'text_embeddings')).resolves.toMatchObject({
      provider: 'custom-provider',
      modelId: 'text-embed',
    });

    database.sqlite.close();
  });

  it('requires a valid encryption key before storing BYOK keys', async () => {
    const database = testDatabase();
    const missing = new ModelStore(
      database.db,
      testModelDefaults({ encryptionKeyBase64: null }),
    );
    await expect(
      missing.setApiKey('guild', 'text_classifier', 'secret'),
    ).rejects.toThrow('API_KEY_ENCRYPTION_KEY is required');

    const invalid = new ModelStore(
      database.db,
      testModelDefaults({
        encryptionKeyBase64: Buffer.alloc(8).toString('base64'),
      }),
    );
    await expect(
      invalid.setApiKey('guild', 'text_classifier', 'secret'),
    ).rejects.toThrow('must be base64 encoded 32 bytes');

    database.sqlite.close();
  });
});

describe('verbose logging settings', () => {
  it('persists admin verbose model logging in the database', async () => {
    const database = testDatabase();

    await setVerboseLogging(database.db, false);
    expect(isVerboseLoggingEnabled()).toBe(false);

    await expect(toggleVerboseLogging(database.db)).resolves.toBe(true);
    expect(isVerboseLoggingEnabled()).toBe(true);
    await expect(loadVerboseLogging(database.db)).resolves.toBe(true);

    await expect(toggleVerboseLogging(database.db)).resolves.toBe(false);
    expect(isVerboseLoggingEnabled()).toBe(false);
    await expect(loadVerboseLogging(database.db)).resolves.toBe(false);

    database.sqlite.close();
  });
});

describe('EvidenceAnalyzer', () => {
  it('keeps exact known text evidence decisive while still recording classifier reasoning', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    const cached = cachedMessage({ content: 'Free Nitro', textHash: 'hash' });
    await database.db.insert(knownTexts).values({
      id: 'known',
      normalizedText: 'free nitro',
      textHash: 'hash',
      embeddingProvider: 'openrouter',
      embeddingModel: 'embed-model',
      embeddingDimensions: 3,
      embeddingVectorJson: JSON.stringify([1, 0, 0]),
      description: 'known',
      scamReason: 'fake giveaway',
      sourceCaseId: null,
      sourceDiscordMessageId: null,
      approvedBy: 'admin',
      scope: 'global',
      guildId: null,
      status: 'approved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const classifier = {
      classify: vi.fn(async (): Promise<ClassificationResult> => ({
        verdict: 'needs_review',
        confidence: 0,
        rationale: 'unused',
        labels: [],
      })),
    };
    const analyzer = new EvidenceAnalyzer(store, classifier);
    const progress: AnalysisProgress[] = [];

    const result = await analyzer.analyze(
      caseRow.id,
      cached,
      defaultGuildConfig({ evidenceConfidenceThreshold: 0.9 }),
      async (update) => {
        progress.push(update);
      },
    );

    expect(progress.map((update) => update.phase)).toEqual([
      'matches',
      'embeddings',
      'classifier',
    ]);
    expect(progress[0]?.result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'exact_match', matched: true }),
        expect.objectContaining({ type: 'fuzzy_match', matched: true }),
      ]),
    );
    expect(
      progress[0]?.result.evidence.some((item) => item.type === 'classifier'),
    ).toBe(false);
    expect(progress[1]?.result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'embedding_retrieval',
          matched: false,
          summary:
            'Embedding retrieval skipped: no embedding provider is configured.',
        }),
      ]),
    );
    expect(result).toMatchObject({ confidence: 1, shouldPunish: true });
    expect(result.reason).toContain('Exact known text match: fake giveaway');
    expect(classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({ textHash: 'hash' }),
      expect.objectContaining({
        evidenceSummary: expect.stringContaining(
          'Exact known text match: fake giveaway',
        ),
        proximalKnownScams: [
          expect.objectContaining({ id: 'known', source: 'text_fuzzy' }),
        ],
      }),
    );
    expect(await store.getCase(caseRow.id)).toMatchObject({
      reason: expect.stringContaining('fake giveaway'),
    });

    database.sqlite.close();
  });

  it('starts embeddings before publishing cheap match progress', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    await database.db.insert(knownTexts).values({
      id: 'known-progress',
      normalizedText: 'free nitro',
      textHash: 'hash-progress',
      embeddingProvider: 'openrouter',
      embeddingModel: 'embed-model',
      embeddingDimensions: 3,
      embeddingVectorJson: JSON.stringify([1, 0, 0]),
      description: 'known',
      scamReason: 'fake giveaway',
      sourceCaseId: null,
      sourceDiscordMessageId: null,
      approvedBy: 'admin',
      scope: 'global',
      guildId: null,
      status: 'approved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const events: string[] = [];
    let resolveEmbedding!: (value: EmbeddingResult) => void;
    const embedding = new Promise<EmbeddingResult>((resolve) => {
      resolveEmbedding = resolve;
    });
    const classifier = {
      classify: vi.fn(async (): Promise<ClassificationResult> => ({
        verdict: 'needs_review',
        confidence: 0,
        rationale: 'classifier finished',
        labels: [],
      })),
    };
    const embedder = {
      embedText: vi.fn(() => {
        events.push('embedding-started');
        return embedding;
      }),
      embedImage: vi.fn(async () => null),
    };
    const analyzer = new EvidenceAnalyzer(store, classifier, embedder);

    await analyzer.analyze(
      caseRow.id,
      cachedMessage({ content: 'free nitro', textHash: 'hash-progress' }),
      defaultGuildConfig({ evidenceConfidenceThreshold: 0.9 }),
      async (update) => {
        events.push(`progress:${update.phase}`);
        if (update.phase === 'matches') {
          expect(update.result.confidence).toBe(1);
          expect(
            update.result.evidence.some((item) => item.type === 'classifier'),
          ).toBe(false);
          resolveEmbedding({
            provider: 'openrouter',
            model: 'embed-model',
            dimensions: 3,
            vector: [1, 0, 0],
          });
        }
      },
    );

    expect(events.slice(0, 2)).toEqual([
      'embedding-started',
      'progress:matches',
    ]);
    expect(events).toContain('progress:embeddings');

    database.sqlite.close();
  });

  it('embeds every image attachment before proximal lookup', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    const classifier = {
      classify: vi.fn(async (): Promise<ClassificationResult> => ({
        verdict: 'needs_review',
        confidence: 0,
        rationale: 'done',
        labels: [],
      })),
    };
    const embedder = {
      embedText: vi.fn(async () => null),
      embedImage: vi.fn(async (): Promise<EmbeddingResult> => ({
        provider: 'openrouter',
        model: 'image-embed',
        dimensions: 3,
        vector: [0, 1, 0],
      })),
    };
    const analyzer = new EvidenceAnalyzer(store, classifier, embedder);

    await analyzer.analyze(
      caseRow.id,
      cachedMessage({
        attachments: [
          storedAttachment({ id: 'image-1', contentType: 'image/png' }),
          storedAttachment({ id: 'image-2', contentType: 'image/jpeg' }),
          storedAttachment({ id: 'image-3', contentType: 'image/webp' }),
          storedAttachment({ id: 'image-4', contentType: 'image/gif' }),
          storedAttachment({ id: 'image-5', contentType: 'image/heic' }),
        ],
      }),
      defaultGuildConfig(),
    );

    expect(embedder.embedImage).toHaveBeenCalledTimes(5);
    expect(embedder.embedImage).toHaveBeenCalledWith(
      'guild',
      expect.objectContaining({ id: 'image-5' }),
    );

    database.sqlite.close();
  });

  it('converts classifier confidence into scam likelihood score without caching repeats', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'crosschannel',
      reason: 'triggered',
    });
    const cached = cachedMessage({ content: 'hello', textHash: 'hash2' });
    const classifier = {
      classify: vi.fn(async () => ({
        verdict: 'not_scam' as const,
        confidence: 0.99,
        rationale: 'benign',
        labels: [],
      })),
    };
    const analyzer = new EvidenceAnalyzer(store, classifier);

    const first = await analyzer.analyze(
      caseRow.id,
      cached,
      defaultGuildConfig({ evidenceConfidenceThreshold: 0.9 }),
    );
    const second = await analyzer.analyze(
      caseRow.id,
      cached,
      defaultGuildConfig({ evidenceConfidenceThreshold: 0.9 }),
    );

    expect(first).not.toBe(second);
    expect(first).toMatchObject({ confidence: 0, shouldPunish: false });
    expect(first.reason).toContain('0% benign');
    expect(second.reason).toContain('0% benign');
    expect(classifier.classify).toHaveBeenCalledTimes(2);

    database.sqlite.close();
  });

  it('passes proximal known scams and reference images into classifier context', async () => {
    const database = testDatabase();
    const storage = fakeStorage();
    const store = new CaseStore(database.db, storage);
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'crosschannel',
      reason: 'triggered',
    });
    const now = new Date().toISOString();
    await database.db.insert(knownTexts).values({
      id: 'known-text',
      normalizedText: 'free nitro giveaway claim yours now',
      textHash: 'known-hash',
      embeddingProvider: 'openrouter',
      embeddingModel: 'embed-model',
      embeddingDimensions: 3,
      embeddingVectorJson: JSON.stringify([1, 0, 0]),
      description: 'Fake Nitro template',
      scamReason: 'phishing lure',
      sourceCaseId: 'source-case',
      sourceDiscordMessageId: null,
      approvedBy: 'admin',
      scope: 'global',
      guildId: null,
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    });
    await database.db.insert(knownImages).values({
      id: 'known-image',
      sha256: 'known-sha',
      perceptualHash: null,
      storageKey: 'guild/source/image.png',
      embeddingProvider: 'openrouter',
      embeddingModel: 'embed-model',
      embeddingDimensions: 3,
      embeddingVectorJson: JSON.stringify([0, 1, 0]),
      description: 'Fake Nitro image',
      scamReason: 'phishing image',
      sourceCaseId: 'source-case',
      sourceDiscordAttachmentId: null,
      approvedBy: 'admin',
      scope: 'global',
      guildId: null,
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    });
    const classifier = {
      classify: vi.fn(
        async (...args: unknown[]): Promise<ClassificationResult> => {
          void args;
          return {
            verdict: 'needs_review',
            confidence: 0,
            rationale: 'compare only',
            labels: [],
          };
        },
      ),
    };
    const analyzer = new EvidenceAnalyzer(store, classifier);

    await analyzer.analyze(
      caseRow.id,
      cachedMessage({
        normalizedContent: 'free nitro giveaway claim yours today',
        textHash: 'new-hash',
      }),
      defaultGuildConfig(),
    );

    expect(classifier.classify.mock.calls[0]?.[1]).toMatchObject({
      proximalKnownScams: [
        expect.objectContaining({
          id: 'known-text',
          scamReason: 'phishing lure',
          images: [
            expect.objectContaining({
              dataUrl: 'data:image/png;base64,aW1hZ2U=',
            }),
          ],
        }),
      ],
    });
    database.sqlite.close();
  });

  it('uses stored embeddings to retrieve proximal known scams and record evidence', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'crosschannel',
      reason: 'triggered',
    });
    const now = new Date().toISOString();
    await database.db.insert(knownTexts).values({
      id: 'known-embedding',
      normalizedText: 'different words entirely',
      textHash: 'known-hash',
      embeddingProvider: 'openrouter',
      embeddingModel: 'embed-model',
      embeddingDimensions: 3,
      embeddingVectorJson: JSON.stringify([1, 0, 0]),
      description: 'Semantic match',
      scamReason: 'same scam semantics',
      sourceCaseId: null,
      sourceDiscordMessageId: null,
      approvedBy: 'admin',
      scope: 'global',
      guildId: null,
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    });
    const classifier = {
      classify: vi.fn(async (): Promise<ClassificationResult> => ({
        verdict: 'not_scam',
        confidence: 0.1,
        rationale: 'primary benign',
        labels: [],
      })),
    };
    const embedder = {
      embedText: vi.fn(async (): Promise<EmbeddingResult> => ({
        provider: 'openrouter',
        model: 'embed-model',
        dimensions: 3,
        vector: [1, 0, 0],
      })),
      embedImage: vi.fn(),
    };
    const analyzer = new EvidenceAnalyzer(store, classifier, embedder);

    const result = await analyzer.analyze(
      caseRow.id,
      cachedMessage({
        content: 'unrelated surface text',
        normalizedContent: 'unrelated surface text',
      }),
      defaultGuildConfig({ knownTextSimilarityThreshold: 0.8 }),
    );

    expect(result.confidence).toBe(1);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'embedding_retrieval',
          matched: true,
          score: 1,
          summary:
            '100% embedding match. The message looks similar to 1 known scam example in the corpus.',
          metadata: expect.objectContaining({ source: 'text_embedding' }),
        }),
      ]),
    );
    expect(classifier.classify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        proximalKnownScams: [
          expect.objectContaining({
            id: 'known-embedding',
            source: 'text_embedding',
          }),
        ],
      }),
    );

    database.sqlite.close();
  });

  it('records additional model signals as advisory evidence without driving confidence', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    const classifier = {
      classify: vi.fn(async (): Promise<ClassificationResult> => ({
        verdict: 'not_scam',
        confidence: 0.95,
        rationale: 'primary benign',
        labels: [],
      })),
      additionalSignals: vi.fn(async () => [
        {
          verdict: 'scam' as const,
          confidence: 0.99,
          rationale: 'secondary suspicious',
          labels: [],
          modelId: 'extra-model',
        },
      ]),
    };
    const analyzer = new EvidenceAnalyzer(store, classifier);

    const result = await analyzer.analyze(
      caseRow.id,
      cachedMessage({ content: 'free nitro maybe joke' }),
      defaultGuildConfig(),
    );

    expect(result.confidence).toBe(0);
    expect(result.shouldPunish).toBe(false);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: 'secondary suspicious',
          metadata: expect.objectContaining({
            source: 'additional_signal',
            modelId: 'extra-model',
            advisoryOnly: true,
          }),
        }),
      ]),
    );
    database.sqlite.close();
  });

  it('records classifier failures as needs-review evidence', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    const classifier = {
      classify: vi.fn(async () => Promise.reject(new Error('offline'))),
    };
    const analyzer = new EvidenceAnalyzer(store, classifier);

    const result = await analyzer.analyze(
      caseRow.id,
      cachedMessage({ content: 'x' }),
      defaultGuildConfig(),
    );

    expect(result.reason).toContain('Classifier unavailable: offline');
    expect(result.confidence).toBe(0);

    database.sqlite.close();
  });
});

describe('CaseStore', () => {
  it('migrates legacy uncertain operations to reconcilable statuses', () => {
    const database = testDatabaseWithSetup((sqlite) => {
      sqlite.exec(`
        CREATE TABLE cases (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          status TEXT NOT NULL,
          action_taken TEXT,
          reason TEXT,
          evidence_summary_json TEXT NOT NULL,
          review_channel_id TEXT,
          review_message_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE case_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          case_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          reason TEXT,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO cases VALUES
          ('punish', 'guild', 'user', 'honeypot', 'operation_uncertain', NULL, NULL, '{}', NULL, NULL, 'now', 'now'),
          ('dismiss', 'guild', 'user', 'honeypot', 'operation_uncertain', NULL, NULL, '{}', NULL, NULL, 'now', 'now'),
          ('revert-punishment', 'guild', 'user', 'honeypot', 'operation_uncertain', 'ban', NULL, '{}', NULL, NULL, 'now', 'now'),
          ('revert-dismissal', 'guild', 'user', 'honeypot', 'operation_uncertain', NULL, NULL, '{}', NULL, NULL, 'now', 'now');
        INSERT INTO case_events
          (case_id, event_type, actor_type, actor_id, reason, metadata_json, created_at)
        VALUES
          ('punish', 'operation_outcome_uncertain', 'bot', NULL, NULL, '{"operation":"punish"}', 'now'),
          ('dismiss', 'operation_outcome_uncertain', 'bot', NULL, NULL, '{"operation":"dismiss"}', 'now'),
          ('revert-punishment', 'operation_outcome_uncertain', 'bot', NULL, NULL, '{"operation":"revert_punishment"}', 'now'),
          ('revert-dismissal', 'operation_outcome_uncertain', 'bot', NULL, NULL, '{"operation":"revert_dismissal"}', 'now');
      `);
    });

    expect(
      database.sqlite.prepare('SELECT id, status FROM cases ORDER BY id').all(),
    ).toEqual([
      { id: 'dismiss', status: 'dismissal_uncertain' },
      { id: 'punish', status: 'punishment_uncertain' },
      {
        id: 'revert-dismissal',
        status: 'dismissal_revert_uncertain',
      },
      {
        id: 'revert-punishment',
        status: 'punishment_revert_uncertain',
      },
    ]);
    expect(
      database.sqlite
        .prepare('PRAGMA table_info(cases)')
        .all()
        .map((column) => (column as { name: string }).name),
    ).toContain('operation_action_taken');

    database.sqlite.close();
  });

  it('atomically caps concurrent attachment processing per case', async () => {
    const database = testDatabase();
    let active = 0;
    let maxActive = 0;
    const storage = fakeStorage();
    storage.saveFromUrl.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        storageKey: 'guild/case/file.png',
        sha256: 'sha256',
        sizeBytes: 456,
        path: '/tmp/guild/case/file.png',
        contentType: 'image/png',
        fileName: 'file.png',
        normalized: false,
      };
    });
    const store = new CaseStore(database.db, storage);
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'concurrent-user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, messageIndex) =>
        attachCaseMessage(
          store,
          caseRow.id,
          fakeMessage({
            id: `concurrent-${messageIndex}`,
            attachments: Array.from({ length: 8 }, (_, attachmentIndex) =>
              attachment({ id: `${messageIndex}-${attachmentIndex}` }),
            ),
          }),
        ),
      ),
    );

    expect(storage.saveFromUrl).toHaveBeenCalledTimes(MAX_ATTACHMENTS_PER_CASE);
    expect(maxActive).toBe(1);
    expect(
      await database.db
        .select()
        .from(caseAttachments)
        .where(eq(caseAttachments.caseId, caseRow.id)),
    ).toHaveLength(64);
    database.sqlite.close();
  });

  it('counts only admitted downloads toward the per-message limit', async () => {
    const database = testDatabase();
    const storage = fakeStorage();
    const store = new CaseStore(database.db, storage);
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'mixed-size-user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    const oversized = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE },
      (_, index) =>
        attachment({
          id: `oversized-${index}`,
          size: MAX_ATTACHMENT_BYTES + 1,
        }),
    );

    await attachCaseMessage(
      store,
      caseRow.id,
      fakeMessage({
        id: 'mixed-size-message',
        attachments: [
          ...oversized,
          attachment({ id: 'admitted', url: 'https://cdn.test/admitted.png' }),
        ],
      }),
    );

    expect(storage.saveFromUrl).toHaveBeenCalledTimes(1);
    expect(storage.saveFromUrl).toHaveBeenCalledWith(
      'https://cdn.test/admitted.png',
      ['guild', caseRow.id],
      'image.png',
      { contentType: 'image/png', expectedSizeBytes: 123 },
    );
    const rows = await database.db
      .select()
      .from(caseAttachments)
      .where(eq(caseAttachments.caseId, caseRow.id));
    expect(rows.filter((row) => row.processingState === 'stored')).toHaveLength(
      1,
    );
    expect(rows.filter((row) => row.processingState === null)).toHaveLength(
      MAX_ATTACHMENTS_PER_MESSAGE,
    );

    database.sqlite.close();
  });

  it('does not let non-images consume image evidence slots', async () => {
    const database = testDatabase();
    const storage = fakeStorage();
    const store = new CaseStore(database.db, storage);
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'mixed-evidence-user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    const nonImages = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE },
      (_, index) =>
        attachment({
          id: `document-${index}`,
          name: `document-${index}.pdf`,
          contentType: 'application/pdf',
        }),
    );

    await attachCaseMessage(
      store,
      caseRow.id,
      fakeMessage({
        id: 'mixed-evidence-message',
        attachments: [
          ...nonImages,
          attachment({ id: 'image-evidence' }),
        ],
      }),
    );

    expect(storage.saveFromUrl).toHaveBeenCalledOnce();
    const rows = await database.db
      .select()
      .from(caseAttachments)
      .where(eq(caseAttachments.caseId, caseRow.id));
    expect(
      rows.find((row) => row.discordAttachmentId === 'image-evidence'),
    ).toMatchObject({ processingState: 'stored' });
    const documentRows = rows.filter((row) =>
      row.discordAttachmentId.startsWith('document-'),
    );
    expect(documentRows).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    for (const row of documentRows) {
      expect(row).toMatchObject({ processingState: null, storageKey: null });
    }

    database.sqlite.close();
  });

  it('keeps skipped attachments as metadata without exceeding processing limits', async () => {
    const database = testDatabase();
    const storage = fakeStorage();
    const store = new CaseStore(database.db, storage);
    const perMessageCase = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'per-message-user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    await attachCaseMessage(
      store,
      perMessageCase.id,
      fakeMessage({
        id: 'per-message',
        attachments: Array.from({ length: 10 }, (_, index) =>
          attachment({ id: `per-message-${index}` }),
        ),
      }),
    );
    expect(storage.saveFromUrl).toHaveBeenCalledTimes(
      MAX_ATTACHMENTS_PER_MESSAGE,
    );

    const perCase = await store.getOrCreateCase(
      {
        guildId: 'guild',
        userId: 'per-case-user',
        triggerType: 'honeypot',
        reason: 'triggered',
      },
      { reusePending: false },
    );

    for (let messageIndex = 0; messageIndex < 5; messageIndex += 1) {
      await attachCaseMessage(
        store,
        perCase.id,
        fakeMessage({
          id: `per-case-message-${messageIndex}`,
          attachments: Array.from({ length: 8 }, (_, attachmentIndex) =>
            attachment({
              id: `per-case-${messageIndex}-${attachmentIndex}`,
            }),
          ),
        }),
      );
    }
    expect(storage.saveFromUrl).toHaveBeenCalledTimes(
      MAX_ATTACHMENTS_PER_MESSAGE + MAX_ATTACHMENTS_PER_CASE,
    );

    const oversizedCase = await store.getOrCreateCase(
      {
        guildId: 'guild',
        userId: 'oversized-user',
        triggerType: 'honeypot',
        reason: 'triggered',
      },
      { reusePending: false },
    );
    await attachCaseMessage(
      store,
      oversizedCase.id,
      fakeMessage({
        id: 'oversized-message',
        attachments: [
          attachment({ id: 'oversized', size: MAX_ATTACHMENT_BYTES + 1 }),
        ],
      }),
    );

    const [oversized] = await database.db
      .select()
      .from(caseAttachments)
      .where(eq(caseAttachments.caseId, oversizedCase.id));
    expect(oversized).toMatchObject({
      sizeBytes: MAX_ATTACHMENT_BYTES + 1,
      storageKey: null,
      sha256: null,
    });
    expect(storage.saveFromUrl).toHaveBeenCalledTimes(
      MAX_ATTACHMENTS_PER_MESSAGE + MAX_ATTACHMENTS_PER_CASE,
    );

    database.sqlite.close();
  });

  it('recovers pending attachment downloads without retrying terminal failures', async () => {
    const database = testDatabase();
    const seedStore = new CaseStore(database.db, fakeStorage());
    const caseRow = await seedStore.getOrCreateCase({
      guildId: 'guild',
      userId: 'restart-user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    const [caseMessage] = await database.db
      .insert(caseMessages)
      .values({
        caseId: caseRow.id,
        messageId: 'restart-message',
        channelId: 'channel',
        authorId: 'restart-user',
        content: '',
        normalizedContent: '',
        textHash: null,
        deleted: 0,
        createdAt: new Date().toISOString(),
      })
      .returning();
    if (!caseMessage) throw new Error('Failed to seed case message');
    const attachmentValues = {
      caseId: caseRow.id,
      caseMessageId: caseMessage.id,
      name: 'evidence.png',
      reviewAttachmentUrl: null,
      contentType: 'image/png',
      sizeBytes: 123,
      sha256: null,
      perceptualHash: null,
      storageKey: null,
      createdAt: new Date().toISOString(),
    };
    await database.db.insert(caseAttachments).values([
      {
        ...attachmentValues,
        discordAttachmentId: 'pending',
        originalUrl: 'https://cdn.test/pending.png',
        processingSlot: 1,
        processingState: 'pending',
      },
      {
        ...attachmentValues,
        discordAttachmentId: 'failed',
        originalUrl: 'https://cdn.test/failed.png',
        processingSlot: 2,
        processingState: 'failed',
      },
    ]);

    const storage = fakeStorage();
    const restartedStore = new CaseStore(database.db, storage);

    await expect(restartedStore.recoverInterruptedAttachments()).resolves.toBe(
      1,
    );
    expect(storage.saveFromUrl).toHaveBeenCalledTimes(1);
    expect(storage.saveFromUrl).toHaveBeenCalledWith(
      'https://cdn.test/pending.png',
      ['guild', caseRow.id],
      'evidence.png',
      { contentType: 'image/png', expectedSizeBytes: 123 },
    );
    expect(
      await database.db
        .select()
        .from(caseAttachments)
        .where(eq(caseAttachments.discordAttachmentId, 'pending'))
        .get(),
    ).toMatchObject({
      processingState: 'stored',
      storageKey: 'guild/case/file.png',
      sha256: 'sha256',
    });
    expect(
      await database.db
        .select()
        .from(caseAttachments)
        .where(eq(caseAttachments.discordAttachmentId, 'failed'))
        .get(),
    ).toMatchObject({ processingState: 'failed', storageKey: null });

    database.sqlite.close();
  });

  it('allows only one concurrent operation claim from the expected case status', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });

    const transitions = await Promise.all([
      store.claimOperation(caseRow.id, 'dismiss', 'moderator-1'),
      store.claimOperation(caseRow.id, 'punish', 'moderator-2'),
    ]);

    expect(transitions.filter(Boolean)).toHaveLength(1);
    await expect(
      store.claimOperation(caseRow.id, 'dismiss', 'moderator-3'),
    ).resolves.toBeNull();
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.caseId, caseRow.id)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'operation_claimed',
        }),
      ]),
    );

    database.sqlite.close();
  });

  it('marks interrupted operations uncertain instead of retrying side effects', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const pendingCase = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'pending-user',
      triggerType: 'honeypot',
      reason: 'triggered',
    });
    const punishedCase = await store.getOrCreateCase(
      {
        guildId: 'guild',
        userId: 'punished-user',
        triggerType: 'honeypot',
        reason: 'triggered',
      },
      { reusePending: false },
    );
    await store.resolve(
      punishedCase.id,
      'punished',
      'ban',
      'moderator',
      'punished',
    );
    await store.claimOperation(pendingCase.id, 'punish', 'moderator', 'ban');
    await store.claimOperation(
      punishedCase.id,
      'revert_punishment',
      'moderator',
      null,
    );

    await expect(store.recoverInterruptedOperations()).resolves.toBe(2);
    await expect(store.recoverInterruptedOperations()).resolves.toBe(0);
    expect(await store.getCase(pendingCase.id)).toMatchObject({
      status: 'punishment_uncertain',
      actionTaken: null,
      operationActionTaken: 'ban',
    });
    expect(await store.getCase(punishedCase.id)).toMatchObject({
      status: 'punishment_revert_uncertain',
      actionTaken: 'ban',
      operationActionTaken: null,
    });
    await expect(
      store.claimOperation(pendingCase.id, 'punish', 'moderator'),
    ).resolves.toBeNull();
    await expect(
      store.reconcileOperation(pendingCase.id, true, 'moderator'),
    ).resolves.toMatchObject({ status: 'punished', actionTaken: 'ban' });
    await expect(
      store.reconcileOperation(punishedCase.id, false, 'moderator'),
    ).resolves.toMatchObject({ status: 'punished', actionTaken: 'ban' });
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.eventType, 'operation_outcome_uncertain')),
    ).toHaveLength(2);

    database.sqlite.close();
  });

  it('creates cases once, persists messages, resolves, and finds by message ids', async () => {
    const database = testDatabase();
    const storage = fakeStorage();
    const store = new CaseStore(database.db, storage);

    const first = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'first',
    });
    const second = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'second',
    });
    expect(second.id).toBe(first.id);

    await attachCaseMessage(
      store,
      first.id,
      fakeMessage({
        id: 'source',
        content: 'Free Nitro',
        attachments: [attachment({ id: 'a1', name: 'proof.png' })],
      }),
    );
    await store.setReviewMessage(first.id, 'review-channel', 'review-message');
    await store.markMessageDeleted('source');
    await store.resolve(first.id, 'dismissed', null, 'actor', 'not scam');

    expect(await store.getCaseBySourceMessage('source')).toMatchObject({
      id: first.id,
    });
    expect(
      await store.getCaseByReviewMessage('guild', 'review-message'),
    ).toMatchObject({ id: first.id });
    expect(
      await database.db
        .select()
        .from(caseMessages)
        .where(eq(caseMessages.messageId, 'source'))
        .get(),
    ).toMatchObject({ deleted: 1 });
    expect(
      await database.db
        .select()
        .from(cases)
        .where(eq(cases.id, first.id))
        .get(),
    ).toMatchObject({ status: 'dismissed', reason: 'not scam' });

    database.sqlite.close();
  });

  it('promotes retained case evidence to global known scams with embeddings and skips duplicates', async () => {
    const database = testDatabase();
    const embedder = {
      embedText: vi.fn(async (): Promise<EmbeddingResult> => ({
        provider: 'openrouter',
        model: 'embed-model',
        dimensions: 3,
        vector: [1, 0, 0],
      })),
      embedImage: vi.fn(async (): Promise<EmbeddingResult> => ({
        provider: 'openrouter',
        model: 'embed-model',
        dimensions: 3,
        vector: [0, 1, 0],
      })),
    };
    const store = new CaseStore(database.db, fakeStorage(), embedder);
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'scam reason',
    });
    await attachCaseMessage(
      store,
      caseRow.id,
      fakeMessage({
        id: 'msg',
        content: 'Free Nitro',
        attachments: [attachment({ id: 'img', name: 'scam.png' })],
      }),
    );

    const first = await store.promoteCaseToGlobalKnownScams(
      caseRow.id,
      'admin',
    );
    const second = await store.promoteCaseToGlobalKnownScams(
      caseRow.id,
      'admin',
    );

    expect(first).toEqual({
      textAdded: 1,
      textSkipped: 0,
      imageAdded: 1,
      imageSkipped: 0,
    });
    expect(second).toEqual({
      textAdded: 0,
      textSkipped: 1,
      imageAdded: 0,
      imageSkipped: 1,
    });
    const [knownText] = await database.db.select().from(knownTexts);
    const [knownImage] = await database.db.select().from(knownImages);
    expect(knownText).toMatchObject({
      embeddingProvider: 'openrouter',
      embeddingModel: 'embed-model',
      embeddingDimensions: 3,
      embeddingVectorJson: JSON.stringify([1, 0, 0]),
    });
    expect(knownImage).toMatchObject({
      embeddingProvider: 'openrouter',
      embeddingModel: 'embed-model',
      embeddingDimensions: 3,
      embeddingVectorJson: JSON.stringify([0, 1, 0]),
    });
    expect(
      await database.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.caseId, caseRow.id)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'known_scam_promoted' }),
      ]),
    );

    database.sqlite.close();
  });

  it('does not promote corpus rows when embeddings are unavailable', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage(), {
      embedText: vi.fn(async () => null),
      embedImage: vi.fn(async () => null),
    });
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'scam reason',
    });
    await attachCaseMessage(
      store,
      caseRow.id,
      fakeMessage({
        id: 'msg-no-embeddings',
        content: 'Free Nitro',
        attachments: [attachment({ id: 'img-no-embeddings' })],
      }),
    );

    await expect(
      store.promoteCaseToGlobalKnownScams(caseRow.id, 'admin'),
    ).resolves.toEqual({
      textAdded: 0,
      textSkipped: 1,
      imageAdded: 0,
      imageSkipped: 1,
    });
    expect(await database.db.select().from(knownTexts)).toHaveLength(0);
    expect(await database.db.select().from(knownImages)).toHaveLength(0);

    database.sqlite.close();
  });

  it('ignores approved corpus rows that are missing embeddings', async () => {
    const database = testDatabase();
    const store = new CaseStore(database.db, fakeStorage());
    const now = new Date().toISOString();
    await database.db.insert(knownTexts).values({
      id: 'invalid-known-text',
      normalizedText: 'free nitro',
      textHash: 'invalid-hash',
      embeddingProvider: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embeddingVectorJson: null,
      description: 'invalid',
      scamReason: 'missing embedding',
      sourceCaseId: null,
      sourceDiscordMessageId: null,
      approvedBy: 'admin',
      scope: 'global',
      guildId: null,
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    });
    await database.db.insert(knownImages).values({
      id: 'invalid-known-image',
      sha256: 'invalid-sha',
      perceptualHash: null,
      storageKey: 'guild/case/file.png',
      embeddingProvider: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embeddingVectorJson: null,
      description: 'invalid',
      scamReason: 'missing embedding',
      sourceCaseId: null,
      sourceDiscordAttachmentId: null,
      approvedBy: 'admin',
      scope: 'global',
      guildId: null,
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    });

    expect(await store.findKnownTextByHash('guild', 'invalid-hash')).toBeNull();
    expect(await store.findKnownImageBySha('guild', 'invalid-sha')).toBeNull();
    expect(await store.listKnownCorpus('guild')).toMatchObject({
      items: [],
      total: 0,
    });

    database.sqlite.close();
  });

  it('dismisses and deletes retained data plus stored files', async () => {
    const database = testDatabase();
    const storage = fakeStorage();
    const store = new CaseStore(database.db, storage);
    const caseRow = await store.getOrCreateCase({
      guildId: 'guild',
      userId: 'user',
      triggerType: 'honeypot',
      reason: 'scam',
    });
    await attachCaseMessage(
      store,
      caseRow.id,
      fakeMessage({ attachments: [attachment({ id: 'img' })] }),
    );

    await store.dismissAndDeleteCase(caseRow.id, 'actor', 'dismissed');

    expect(storage.removed).toEqual(['guild/case/file.png']);
    expect(
      await database.db.select().from(cases).where(eq(cases.id, caseRow.id)),
    ).toHaveLength(0);

    database.sqlite.close();
  });
});

async function attachCaseMessage(
  store: CaseStore,
  caseId: string,
  message: ReturnType<typeof fakeMessage>,
) {
  const persisted = await store.attachMessage(caseId, message);
  return {
    ...persisted,
    attachments: await persisted.processedAttachments,
  };
}

function fakeDiscordGuild(
  deleted: string[],
  actions: string[] = [],
  options: { dmError?: Error } = {},
) {
  const member = () => ({
    id: 'user',
    guild,
    permissions: { has: () => false },
    roles: { cache: { some: () => false } },
    send: vi.fn(async () => {
      if (options.dmError) throw options.dmError;
      actions.push('dm');
    }),
    timeout: vi.fn(async () => {
      actions.push('timeout');
    }),
    kick: vi.fn(async () => {
      actions.push('kick');
    }),
  });
  const channels = new Map<
    string,
    {
      messages: { fetch: (id: string) => Promise<any> };
      isTextBased: () => boolean;
    }
  >();
  const guild = {
    id: 'guild',
    ownerId: 'owner',
    members: {
      fetch: vi.fn(async () => member()),
      ban: vi.fn(async () => {
        actions.push('ban');
      }),
    },
    channels: {
      fetch: vi.fn(
        async (channelId: string) => channels.get(channelId) ?? null,
      ),
    },
    register(message: any) {
      const channel = channels.get(message.channelId) ?? {
        isTextBased: () => true,
        messages: {
          fetch: vi.fn(async (messageId: string) =>
            messageId === message.id ? message : null,
          ),
        },
      };
      channel.messages.fetch = vi.fn(async (messageId: string) =>
        messageId === message.id ? message : null,
      );
      channels.set(message.channelId, channel);
      message.guild = guild;
      message.member = member();
      message.delete = vi.fn(async () => {
        actions.push(`delete:${message.id}`);
        deleted.push(message.id);
      });
    },
  };
  return guild;
}

function fakeDiscordMessage(
  input: Partial<{
    id: string;
    guild: ReturnType<typeof fakeDiscordGuild>;
    channelId: string;
    content: string;
    attachments: unknown[];
  }>,
) {
  const attachments = input.attachments ?? [];
  return {
    id: input.id ?? 'message',
    guildId: 'guild',
    channelId: input.channelId ?? 'channel',
    guild: input.guild,
    member: null,
    author: { id: 'user', bot: false },
    webhookId: null,
    content: input.content ?? 'hello',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    deletable: true,
    inGuild: () => true,
    attachments: {
      size: attachments.length,
      map: <T>(fn: (attachment: any) => T) => attachments.map(fn),
      values: () => attachments[Symbol.iterator](),
    },
  } as any;
}

function fakeCaseButtonInteraction(
  guild: ReturnType<typeof fakeDiscordGuild>,
  customId: string,
  userId: string,
) {
  return {
    inCachedGuild: () => true,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => false,
    isButton: () => true,
    customId,
    guildId: guild.id,
    guild,
    user: { id: userId },
    member: {
      id: userId,
      guild,
      permissions: { has: () => false },
      roles: { cache: { some: () => false } },
    },
    client: { application: null },
    message: { components: [] },
    reply: vi.fn(async (payload: unknown) => void payload),
    update: vi.fn(async (payload: unknown) => void payload),
  };
}

function matchesDuplicateAfter(
  delayMs: number,
  now: ReturnType<typeof vi.spyOn>,
  attachments: [unknown[], unknown[]] = [[], []],
) {
  const detector = new DuplicateDetector();
  const config = defaultGuildConfig({
    crosschannelChannelThreshold: 2,
    crosschannelWindowSeconds: 60,
  });

  now.mockReturnValue(0);
  detector.record(
    fakeMessage({
      channelId: 'c1',
      content: 'same',
      attachments: attachments[0],
    }),
    config,
  );
  now.mockReturnValue(delayMs);
  return detector.record(
    fakeMessage({
      channelId: 'c2',
      content: 'same',
      attachments: attachments[1],
    }),
    config,
  ).matched;
}

function fakeMessage(
  input: Partial<{
    id: string;
    guildId: string;
    channelId: string;
    authorId: string;
    content: string;
    attachments: unknown[];
  }> = {},
) {
  const attachments = input.attachments ?? [];
  return {
    id: input.id ?? 'message',
    guildId: input.guildId ?? 'guild',
    channelId: input.channelId ?? 'channel',
    author: { id: input.authorId ?? 'user' },
    content: input.content ?? 'hello',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    attachments: {
      size: attachments.length,
      map: <T>(fn: (attachment: any) => T) => attachments.map(fn),
      values: () => attachments[Symbol.iterator](),
    },
  } as any;
}

function attachment(
  input: Partial<{
    id: string;
    name: string;
    contentType: string;
    size: number;
    url: string;
    proxyURL: string;
  }> = {},
) {
  return {
    id: input.id ?? 'attachment',
    name: input.name ?? 'image.png',
    contentType: input.contentType ?? 'image/png',
    size: input.size ?? 123,
    url: input.url ?? 'https://cdn.discordapp.test/image.png',
    proxyURL: input.proxyURL ?? 'https://proxy.discordapp.test/image.png',
  };
}

function storedAttachment(
  input: Partial<CachedMessage['attachments'][number]> = {},
): CachedMessage['attachments'][number] {
  return {
    id: input.id ?? 'attachment',
    name: input.name ?? 'image.png',
    contentType: input.contentType ?? 'image/png',
    size: input.size ?? 123,
    url: input.url ?? 'https://cdn.discordapp.test/image.png',
    proxyUrl: input.proxyUrl ?? 'https://proxy.discordapp.test/image.png',
    dataUrl: input.dataUrl ?? 'data:image/png;base64,aW1hZ2U=',
    sha256: input.sha256 ?? 'sha',
    storageKey: input.storageKey ?? 'guild/case/file.png',
  };
}

function cachedMessage(input: Partial<CachedMessage> = {}): CachedMessage {
  return {
    id: input.id ?? 'message',
    guildId: input.guildId ?? 'guild',
    channelId: input.channelId ?? 'channel',
    authorId: input.authorId ?? 'user',
    content: input.content ?? 'hello',
    normalizedContent: input.normalizedContent ?? input.content ?? 'hello',
    textHash: input.textHash ?? null,
    attachments: input.attachments ?? [],
    createdAt: input.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    reason: input.reason ?? 'honeypot',
  };
}

async function recordAnalysis(store: CaseStore, caseId: string) {
  await store.saveAnalysis(caseId, {
    confidence: 1,
    shouldPunish: true,
    reason: 'known scam',
    evidence: [],
  });
}

function fakeStorage() {
  return {
    removed: [] as Array<string | null>,
    saveFromUrl: vi.fn(async () => ({
      storageKey: 'guild/case/file.png',
      sha256: 'sha256',
      sizeBytes: 456,
      path: '/tmp/guild/case/file.png',
      contentType: 'image/png',
      fileName: 'file.png',
      normalized: false,
    })),
    read: vi.fn(async () => Buffer.from('image')),
    pathFor: vi.fn((key: string) => `/tmp/${key}`),
    remove: vi.fn(async function (
      this: { removed: Array<string | null> },
      key: string | null,
    ) {
      this.removed.push(key);
    }),
  } as any;
}
