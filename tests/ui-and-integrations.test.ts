import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, RESTJSONErrorCodes } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCommands } from '../src/commands/register.js';
import {
  caseReviewEdit,
  caseReviewMessage,
  caseReviewResolutionUpdate,
  caseReviewRevertUpdate,
  caseReviewUncertainUpdate,
  type CaseReviewInput,
} from '../src/interactions/caseReviewUi.js';
import { refreshRecoveredCaseReviews } from '../src/services/caseReviewRecovery.js';
import { OpenRouterScamClassifier } from '../src/services/classifier.js';
import { OpenRouterEmbeddings } from '../src/services/embeddings.js';
import { GlobalBanService } from '../src/services/globalBanList.js';
import {
  applyPolicyForUser,
  applyPolicyWithBestEffortDm,
  deleteMessage,
  dmPunishedUser,
  revertPolicyForUser,
} from '../src/services/moderation.js';
import { loadClassifierPrompt } from '../src/services/prompts.js';
import { FileStorage } from '../src/storage/fileStorage.js';
import { testDatabase } from './helpers.js';
import {
  CORPUS_UPLOAD_ANOTHER_ID,
  CORPUS_UPLOAD_FILES_ID,
  CORPUS_UPLOAD_MODAL_ID,
  corpusUploadModal,
  corpusUploadReply,
} from '../src/interactions/corpusUi.js';
import { infoReply } from '../src/interactions/infoUi.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('command registration', () => {
  it('registers only the combined settings command plus user-installed global admin actions', async () => {
    const guildSet = vi.fn();
    const appSet = vi.fn((commands) =>
      collection(
        commands.map(
          (command: { name: string; type?: number }, index: number) => ({
            ...command,
            id: String(index),
          }),
        ),
      ),
    );
    const client = {
      guilds: {
        cache: new Map([
          [
            'guild',
            {
              commands: {
                fetch: vi.fn(async () =>
                  collection([{ name: 'stale', type: 1 }]),
                ),
                set: guildSet,
              },
            },
          ],
        ]),
      },
      application: {
        commands: {
          fetch: vi.fn(async () => collection([{ name: 'old', type: 1 }])),
          set: appSet,
        },
      },
    };

    await registerCommands(client as any);

    expect(guildSet).toHaveBeenCalledWith([]);
    const commands = appSet.mock.calls[0]?.[0] as Array<{
      name: string;
      type?: number;
      integrationTypes?: number[];
      options?: Array<{ name: string }>;
    }>;
    expect(commands.map((command) => command.name)).toEqual([
      'info',
      'settings',
      'admin',
      'Mark case as known scam',
      'Ban transgressor globally',
    ]);
    expect(
      commands
        .find((command) => command.name === 'admin')
        ?.options?.map((option: { name: string }) => option.name),
    ).toEqual(['add', 'corpus', 'upload-corpus', 'verbose']);
    expect(
      commands
        .filter((command) => ['info', 'settings'].includes(command.name))
        .map((command) => command.integrationTypes),
    ).toEqual([[0], [0]]);
    expect(
      commands
        .filter((command) => command.name !== 'settings')
        .map((command) => command.integrationTypes),
    ).toEqual([[0], [1], [1], [1]]);
  });

  it('builds public info with manager-only diagnostics', () => {
    const input = {
      version: '1.2.3',
      revision: '1234567890abcdef',
      startedAt: new Date('2026-08-22T08:00:00Z'),
      discordLatencyMs: 42,
      guildCount: 3,
      monitoredChannelCount: 7,
      corpus: { texts: 11, images: 29, missingEmbeddings: 0 },
      cases: { last24Hours: 2, last7Days: 8, retained: 40 },
      models: [
        {
          purpose: 'text_classifier' as const,
          provider: 'openrouter',
          modelId: 'text-model',
          ready: true,
        },
        {
          purpose: 'image_classifier' as const,
          provider: 'openrouter',
          modelId: 'image-model',
          ready: true,
        },
        {
          purpose: 'text_embeddings' as const,
          provider: 'openrouter',
          modelId: 'text-embed',
          ready: true,
        },
        {
          purpose: 'image_embeddings' as const,
          provider: 'openrouter',
          modelId: 'image-embed',
          ready: true,
        },
      ],
      diagnostics: {
        failedAnalysesLast24Hours: 1,
        lastCorpusUpdate: new Date('2026-08-22T07:00:00Z'),
        memoryRssBytes: 128 * 1024 * 1024,
        modelQueue: { active: 1, queued: 2 },
        moderationQueue: { active: 0, queued: 0 },
      },
    };

    const publicReply = infoReply(input, false);
    const managerReply = infoReply(input, true);
    const publicEmbed = publicReply.embeds[0].toJSON();
    const managerEmbed = managerReply.embeds[0].toJSON();

    expect(publicReply.ephemeral).toBe(false);
    expect(managerReply.ephemeral).toBe(true);
    expect(publicEmbed.fields?.map(({ name }) => name)).not.toContain(
      'Manager diagnostics',
    );
    expect(JSON.stringify(publicEmbed)).toContain('v1.2.3');
    expect(JSON.stringify(managerEmbed)).toContain('1234567890ab');
    expect(JSON.stringify(managerEmbed)).toContain('1 active, 2 queued');
  });

  it('builds the global corpus batch upload flow', () => {
    const modal = corpusUploadModal().toJSON();

    expect(modal).toMatchObject({
      custom_id: CORPUS_UPLOAD_MODAL_ID,
      title: 'Add known scam images',
      components: [
        {
          type: 18,
          component: {
            type: 19,
            custom_id: CORPUS_UPLOAD_FILES_ID,
            min_values: 1,
            max_values: 10,
          },
        },
        { type: 18, component: { type: 4, required: false } },
      ],
    });

    const reply = corpusUploadReply({
      added: 1,
      skipped: 1,
      failed: 1,
      items: [
        { name: 'new.png', status: 'added', detail: 'Added.' },
        { name: 'known.png', status: 'skipped', detail: 'Already known.' },
        { name: 'bad.png', status: 'failed', detail: 'Invalid image.' },
      ],
    });
    expect(reply.content).toContain('Added 1, skipped 1, failed 1.');
    expect(reply.content).toContain('Failed `bad.png`: Invalid image.');
    expect(reply.components[0]?.components[0]?.toJSON()).toMatchObject({
      custom_id: CORPUS_UPLOAD_ANOTHER_ID,
      label: 'Add another batch',
    });
    const fullBatchReply = corpusUploadReply({
      added: 0,
      skipped: 0,
      failed: 10,
      items: Array.from({ length: 10 }, (_, index) => ({
        name: `${index}-${'x'.repeat(100)}.png`,
        status: 'failed' as const,
        detail: 'Provider error '.repeat(20),
      })),
    });
    expect(fullBatchReply.content.length).toBeLessThanOrEqual(2_000);
  });
});

describe('case review UI', () => {
  it('builds pending case messages with stable case, signal, and action containers', () => {
    const message = caseReviewMessage(caseInput());
    const components = message.components as Array<any>;

    expect(message.flags).toBe(1 << 15);
    expect(message.allowedMentions).toEqual({
      users: ['mod-user'],
      roles: ['mod-role'],
    });
    expect(components).toHaveLength(4);
    expect(textContent(components)).toContain('# 🍯 Case `case1`');
    expect(textContent(components)).toContain(
      'Likelihood of being a scam: 88%',
    );
    expect(customIds(components)).toEqual([
      'case:punish:case1',
      'case:dismiss:case1',
    ]);
  });

  it('disables punishment until analysis completes', () => {
    const pending = caseReviewMessage(caseInput({ analysis: null }))
      .components as Array<any>;
    expect(componentByCustomId(pending, 'case:punish:case1')).toMatchObject({
      disabled: true,
    });
    expect(componentByCustomId(pending, 'case:dismiss:case1')).toMatchObject({
      disabled: false,
    });

    const progressing = caseReviewEdit(
      caseInput({ punishmentReady: false }),
      pending,
    ).components as Array<any>;
    expect(componentByCustomId(progressing, 'case:punish:case1')).toMatchObject(
      {
        disabled: true,
      },
    );

    const completed = caseReviewEdit(caseInput(), progressing)
      .components as Array<any>;
    expect(componentByCustomId(completed, 'case:punish:case1')).toMatchObject({
      disabled: false,
    });

    const revertedWhilePending = caseReviewRevertUpdate(pending, {
      caseId: 'case1',
      punishment: policy('ban'),
      punishmentReady: false,
    }).components as Array<any>;
    expect(
      componentByCustomId(revertedWhilePending, 'case:punish:case1'),
    ).toMatchObject({ disabled: true });
  });

  it('shows waiting copy before classifier evidence arrives', () => {
    const content = textContent(
      caseReviewMessage(
        caseInput({
          reason: 'No strong evidence found; requires moderator review.',
          analysis: {
            confidence: 0,
            reason: 'No strong evidence found; requires moderator review.',
            shouldPunish: false,
            evidence: [
              {
                type: 'embedding_retrieval',
                matched: false,
                score: 0,
                summary: 'Embedding retrieval is still warming up.',
              },
            ],
          },
        }),
      ).components as Array<any>,
    );

    expect(content).toContain('_Waiting on classifier responses._');
    expect(content).not.toContain('No strong evidence found');
  });

  it('renders classifier reasoning as a real blockquote on its own line', () => {
    const content = textContent(
      caseReviewMessage(caseInput()).components as Array<any>,
    );

    expect(content).toContain(
      '**Primary model** — likelihood of scam: 88%\n> fake nitro',
    );
    expect(content).not.toContain('88% likelihood of a scam. > fake nitro');
  });

  it('renders embedding summaries without generic score prefixes', () => {
    const message = caseReviewMessage(
      caseInput({
        analysis: {
          confidence: 0,
          reason: 'embedding miss',
          shouldPunish: false,
          evidence: [
            {
              type: 'embedding_retrieval',
              matched: false,
              score: 0.99,
              summary:
                'No embedding match. Closest known-scam example was 69% similar; Honeybot requires 82% for this signal.',
            },
          ],
        },
      }),
    );

    const content = textContent(message.components as Array<any>);
    expect(content).toContain(
      'No embedding match. Closest known-scam example was 69% similar; Honeybot requires 82% for this signal.',
    );
    expect(content).not.toContain('99% No embedding match');
    expect(content).not.toContain('Embedded The message');
  });

  it('renders prevention and resolution variants for every policy type', () => {
    const roleCase = caseReviewMessage(
      caseInput({
        prevention: policy('role', { roleId: 'role' }),
        analysis: null,
        triggerType: 'crosschannel',
        duplicateChannelIds: ['other'],
        triggerMessageDeleted: false,
      }),
    ).components as Array<any>;
    expect(textContent(roleCase)).toContain('<@user> was given <@&role>');
    expect(textContent(roleCase)).toContain(
      'duplicate messages across <#channel>, <#other>',
    );

    const unappliedCase = caseReviewMessage(
      caseInput({
        preventionOutcome: {
          applied: false,
          detail:
            'timeout could not be applied because the member left the guild',
          attemptedAtMs: 1_700_000_000_000,
        },
      }),
    ).components as Array<any>;
    expect(textContent(unappliedCase)).toContain(
      'prevention was not applied: timeout could not be applied because the member left the guild',
    );
    expect(textContent(unappliedCase)).not.toContain('<@user> was timed out');
    expect(textContent(roleCase)).toContain(
      'Likelihood of being a scam: pending',
    );

    const logCase = caseReviewMessage(
      caseInput({
        prevention: policy('log'),
        messageContent: '',
        moderatorUserIds: [],
        moderatorRoleIds: [],
      }),
    ).components as Array<any>;
    expect(textContent(logCase)).toContain('@moderators new case triggered');
    expect(textContent(logCase)).toContain('case was logged for review');
    expect(textContent(logCase)).toContain('_empty or attachment-only_');

    for (const action of ['kick', 'timeout', 'role', 'log'] as const) {
      const resolved = caseReviewResolutionUpdate(
        caseReviewMessage(caseInput()).components as Array<any>,
        {
          caseId: 'case1',
          status: 'punished',
          actorId: 'actor',
          userId: 'user',
          detail: 'done',
          punishment: policy(action, {
            roleId: action === 'role' ? 'role' : null,
          }),
          canRevert: true,
        },
      ).components as Array<any>;
      expect(textContent(resolved)).toContain('Resolved by <@actor>');
    }
  });

  it('preserves resolved state when later analysis edits the case message', () => {
    const existing = caseReviewResolutionUpdate(
      caseReviewMessage(caseInput({ analysis: null })).components as Array<any>,
      {
        caseId: 'case1',
        status: 'punished',
        actorId: 'actor',
        userId: 'user',
        detail: 'done',
        punishment: policy('ban'),
        canRevert: true,
      },
    ).components as Array<any>;

    const edited = caseReviewEdit(caseInput(), existing)
      .components as Array<any>;

    expect(textContent(edited)).toContain('# 🔨 <@user> banned');
    expect(textContent(edited)).toContain('Resolved by <@actor>');
    expect(textContent(edited)).toContain(
      '**Primary model** — likelihood of scam: 88%',
    );
    expect(customIds(edited)).toEqual([
      'case:punish:case1',
      'case:dismiss:case1',
      'case:revert:case1',
    ]);
  });

  it('renders uncertain operations with explicit reconciliation actions', () => {
    const existing = caseReviewMessage(caseInput()).components as Array<any>;
    const uncertain = caseReviewUncertainUpdate(existing, {
      caseId: 'case1',
    }).components as Array<any>;

    expect(textContent(uncertain)).toContain('Reconciliation required');
    expect(customIds(uncertain)).toEqual([
      'case:reconcile-applied:case1',
      'case:reconcile-not-applied:case1',
    ]);

    const reconciled = caseReviewRevertUpdate(uncertain, {
      caseId: 'case1',
      punishment: policy('ban'),
      punishmentReady: true,
    }).components as Array<any>;
    expect(textContent(reconciled)).not.toContain('Reconciliation required');
    expect(customIds(reconciled)).toEqual([
      'case:punish:case1',
      'case:dismiss:case1',
    ]);
  });

  it('refreshes recovered uncertain case messages with reconciliation actions', async () => {
    const existing = {
      components: caseReviewMessage(caseInput()).components as Array<any>,
      edit: vi.fn(async (payload: unknown) => void payload),
    };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => existing) },
      send: vi.fn(async (payload: unknown) => void payload),
    };
    const client = {
      guilds: {
        cache: new Map([
          ['guild', { channels: { fetch: vi.fn(async () => channel) } }],
        ]),
      },
    };
    const caseStore = { setReviewMessage: vi.fn() };

    await expect(
      refreshRecoveredCaseReviews(client as any, caseStore as any, [
        {
          caseId: 'case1',
          guildId: 'guild',
          reviewChannelId: 'review-channel',
          reviewMessageId: 'review-message',
        },
      ]),
    ).resolves.toEqual({ updated: 1, reposted: 0, skipped: 0, failed: 0 });

    expect(channel.messages.fetch).toHaveBeenCalledWith('review-message');
    const payload = existing.edit.mock.calls[0]?.[0] as {
      components: Array<any>;
    };
    expect(textContent(payload.components)).toContain(
      'Reconciliation required',
    );
    expect(customIds(payload.components)).toEqual([
      'case:reconcile-applied:case1',
      'case:reconcile-not-applied:case1',
    ]);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('reposts recovered reconciliation controls when the old review is gone', async () => {
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn(async () => {
          throw { code: RESTJSONErrorCodes.UnknownMessage };
        }),
      },
      send: vi.fn(async (payload: unknown) => {
        void payload;
        return {
          id: 'new-review-message',
          channelId: 'review-channel',
        };
      }),
    };
    const client = {
      guilds: {
        cache: new Map([
          [
            'guild',
            { channels: { fetch: vi.fn(async () => channel) } },
          ],
        ]),
      },
    };
    const caseStore = {
      setReviewMessage: vi.fn(async () => undefined),
    };

    await expect(
      refreshRecoveredCaseReviews(client as any, caseStore as any, [
        {
          caseId: 'case1',
          guildId: 'guild',
          reviewChannelId: 'review-channel',
          reviewMessageId: 'old-review-message',
        },
      ]),
    ).resolves.toEqual({ updated: 0, reposted: 1, skipped: 0, failed: 0 });

    const payload = channel.send.mock.calls[0]?.[0] as {
      components: Array<any>;
    };
    expect(textContent(payload.components)).toContain(
      'Reconciliation required',
    );
    expect(customIds(payload.components)).toEqual([
      'case:reconcile-applied:case1',
      'case:reconcile-not-applied:case1',
    ]);
    expect(caseStore.setReviewMessage).toHaveBeenCalledWith(
      'case1',
      'review-channel',
      'new-review-message',
    );
  });

  it('retries recovered review refreshes after transient Discord failures', async () => {
    const existing = {
      components: caseReviewMessage(caseInput()).components as Array<any>,
      edit: vi.fn(async (payload: unknown) => void payload),
    };
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Discord unavailable'))
      .mockResolvedValueOnce(existing);
    const channel = {
      isTextBased: () => true,
      messages: { fetch },
      send: vi.fn(async (payload: unknown) => void payload),
    };
    const client = {
      guilds: {
        cache: new Map([
          ['guild', { channels: { fetch: vi.fn(async () => channel) } }],
        ]),
      },
    };
    const caseStore = { setReviewMessage: vi.fn() };
    const recovered = [
      {
        caseId: 'case1',
        guildId: 'guild',
        reviewChannelId: 'review-channel',
        reviewMessageId: 'review-message',
      },
    ];

    await expect(
      refreshRecoveredCaseReviews(
        client as any,
        caseStore as any,
        recovered,
      ),
    ).resolves.toEqual({ updated: 0, reposted: 0, skipped: 0, failed: 1 });
    await expect(
      refreshRecoveredCaseReviews(
        client as any,
        caseStore as any,
        recovered,
      ),
    ).resolves.toEqual({ updated: 1, reposted: 0, skipped: 0, failed: 0 });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(existing.edit).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('adds and removes resolution containers without mutating case and signal containers', () => {
    const existing = caseReviewMessage(caseInput()).components as Array<any>;
    const resolved = caseReviewResolutionUpdate(existing, {
      caseId: 'case1',
      status: 'punished',
      actorId: 'actor',
      userId: 'user',
      detail: 'done',
      punishment: policy('ban'),
      canRevert: true,
    }).components as Array<any>;
    expect(textContent(resolved)).toContain('# 🔨 <@user> banned');
    expect(customIds(resolved)).toEqual([
      'case:punish:case1',
      'case:dismiss:case1',
      'case:revert:case1',
    ]);

    const reverted = caseReviewRevertUpdate(resolved, {
      caseId: 'case1',
      punishment: policy('ban'),
      punishmentReady: true,
    }).components as Array<any>;
    expect(textContent(reverted)).not.toContain('Resolved by');
    expect(customIds(reverted)).toEqual([
      'case:punish:case1',
      'case:dismiss:case1',
    ]);
  });
});

describe('OpenRouterScamClassifier', () => {
  it('returns needs_review when provider/model/key is not configured', async () => {
    const classifier = new OpenRouterScamClassifier(
      {
        get: vi.fn(async () => ({
          provider: 'custom',
          modelId: null,
          apiKey: null,
          apiKeyHint: null,
        })),
      } as any,
      immediateQueue(),
    );

    await expect(
      classifier.classify(cachedMessage(), classifierContext()),
    ).resolves.toEqual({
      verdict: 'needs_review',
      confidence: 0,
      rationale: 'Classifier provider/model/key is not configured.',
      labels: [],
    });
  });

  it('keeps text classifier payload text-only even when proximal refs have images', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  likelihood: 'not_scam',
                  confidence: 0.9,
                  reason: 'parody text',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const classifier = new OpenRouterScamClassifier(
      {
        get: vi.fn(async () => ({
          provider: 'openrouter',
          modelId: 'model',
          apiKey: 'key',
          apiKeyHint: null,
        })),
      } as any,
      immediateQueue(),
    );

    await classifier.classify(
      cachedMessage({ content: 'totally real free nitro wink' }),
      classifierContext({
        proximalKnownScams: [
          {
            id: 'known',
            sourceCaseId: 'case',
            score: 0.75,
            description: 'Fake Nitro',
            scamReason: 'phishing',
            normalizedText: 'free nitro claim',
            images: [
              {
                id: 'img',
                storageKey: 'known.png',
                contentType: 'image/png',
                sizeBytes: 3,
                dataUrl: 'data:image/png;base64,a25vd24=',
              },
            ],
          },
        ],
      }),
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages[1].content).toHaveLength(1);
    expect(body.messages[1].content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]),
    );
    expect(JSON.parse(body.messages[1].content[0].text)).toMatchObject({
      currentCase: { message: 'totally real free nitro wink' },
      proximalKnownScams: [
        expect.not.objectContaining({ images: expect.anything() }),
      ],
      classifierTask: expect.stringContaining(
        'Always include a non-empty reason field',
      ),
    });
  });

  it('repairs classifier responses that omit the required reason', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    likelihood: 'scam',
                    scam_likelihood: 0.9,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    likelihood: 'scam',
                    scam_likelihood: 0.92,
                    reason:
                      'Fake Nitro claim with reward bait and a call to claim through a suspicious link.',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const classifier = new OpenRouterScamClassifier(
      {
        get: vi.fn(async () => ({
          provider: 'openrouter',
          modelId: 'model',
          apiKey: 'key',
          apiKeyHint: null,
        })),
      } as any,
      immediateQueue(),
    );

    await expect(
      classifier.classify(cachedMessage(), classifierContext()),
    ).resolves.toMatchObject({
      verdict: 'scam',
      confidence: 0.92,
      rationale:
        'Fake Nitro claim with reward bait and a call to claim through a suspicious link.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(repairBody.messages.at(-1).content).toContain(
      'previous JSON omitted the required non-empty reason',
    );
  });

  it('parses successful JSON responses and sends image attachments', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  likelihood: 'scam',
                  confidence: 0.97,
                  reason: 'fake nitro',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const classifier = new OpenRouterScamClassifier(
      {
        get: vi.fn(async () => ({
          provider: 'openrouter',
          modelId: 'model',
          apiKey: 'key',
          apiKeyHint: null,
        })),
      } as any,
      immediateQueue(),
    );

    const result = await classifier.classify(
      cachedMessage({
        attachments: [
          {
            id: 'current',
            name: 'current.png',
            contentType: 'image/png',
            url: 'https://cdn.test/image.png',
            proxyUrl: 'https://proxy.test/image.png',
            dataUrl: 'data:image/png;base64,Y3VycmVudA==',
          },
          {
            id: 'current-2',
            name: 'current-2.jpg',
            contentType: 'image/jpeg',
            url: 'https://cdn.test/image-2.jpg',
            proxyUrl: 'https://proxy.test/image-2.jpg',
          },
        ] as any,
      }),
      classifierContext({
        evidenceSummary: 'evidence',
        proximalKnownScams: [
          {
            id: 'known',
            sourceCaseId: 'case',
            score: 0.82,
            description: 'Fake Nitro',
            scamReason: 'phishing',
            normalizedText: 'free nitro claim',
            images: [
              {
                id: 'img',
                storageKey: 'known.png',
                contentType: 'image/png',
                sizeBytes: 3,
                dataUrl: 'data:image/png;base64,a25vd24=',
              },
            ],
          },
        ],
      }),
    );

    expect(result).toEqual({
      verdict: 'scam',
      confidence: 0.97,
      rationale: 'fake nitro',
      labels: [],
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(
      body.messages[1].content.filter(
        (part: { type?: string }) => part.type === 'image_url',
      ),
    ).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,Y3VycmVudA==' },
      },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,a25vd24=' },
      },
    ]);
    expect(body.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Known scam 1 image 1'),
        }),
      ]),
    );
    const promptJson = JSON.parse(body.messages[1].content[0].text);
    expect(promptJson).toEqual(
      expect.not.objectContaining({ evidenceSummary: expect.anything() }),
    );
    expect(promptJson.proximalKnownScams[0]).toMatchObject({
      reference: 'known_scam_1',
      similarity: 0.82,
      scamReason: 'phishing',
    });
  });

  it('uses numeric scam_likelihood when confidence is omitted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  likelihood: 'scam',
                  scam_likelihood: 0.99,
                  reason: 'textbook scam',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const classifier = new OpenRouterScamClassifier(
      {
        get: vi.fn(async () => ({
          provider: 'openrouter',
          modelId: 'model',
          apiKey: 'key',
          apiKeyHint: null,
        })),
      } as any,
      immediateQueue(),
    );

    await expect(
      classifier.classify(cachedMessage(), classifierContext()),
    ).resolves.toMatchObject({
      verdict: 'scam',
      confidence: 0.99,
      rationale: 'textbook scam',
    });
  });

  it('runs text additional signal models with the same text primary prompt payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    likelihood: 'scam',
                    confidence: 0.7,
                    reason: 'second opinion',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const classifier = new OpenRouterScamClassifier(
      {
        get: vi.fn(async () => ({
          provider: 'openrouter',
          modelId: 'primary-model',
          apiKey: 'key',
          apiKeyHint: null,
        })),
        providerConfig: vi.fn((provider: string, modelId: string | null) => ({
          provider,
          modelId,
          apiKey: 'key',
          apiKeyHint: null,
        })),
      } as any,
      immediateQueue(),
      {
        text: { provider: 'openrouter', models: ['extra-a', 'extra-b'] },
        image: { provider: 'openrouter', models: ['image-extra'] },
      },
    );

    const results = await classifier.additionalSignals?.(
      cachedMessage({ content: 'free nitro' }),
      classifierContext({ evidenceSummary: 'same evidence' }),
    );

    expect(results).toEqual([
      expect.objectContaining({
        modelId: 'extra-a',
        rationale: 'second opinion',
      }),
      expect.objectContaining({
        modelId: 'extra-b',
        rationale: 'second opinion',
      }),
    ]);
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    expect(bodies.map((body) => body.model)).toEqual(['extra-a', 'extra-b']);
    expect(bodies[0].messages[1].content).toEqual(
      bodies[1].messages[1].content,
    );
    expect(JSON.parse(bodies[0].messages[1].content[0].text)).toEqual(
      expect.not.objectContaining({ evidenceSummary: expect.anything() }),
    );
  });

  it('runs image additional signal models for multimodal cases', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    likelihood: 'scam',
                    confidence: 0.8,
                    reason: 'image second opinion',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const classifier = new OpenRouterScamClassifier(
      {
        get: vi.fn(async () => ({
          provider: 'openrouter',
          modelId: 'primary-model',
          apiKey: 'key',
          apiKeyHint: null,
        })),
        providerConfig: vi.fn((provider: string, modelId: string | null) => ({
          provider,
          modelId,
          apiKey: 'key',
          apiKeyHint: null,
        })),
      } as any,
      immediateQueue(),
      {
        text: { provider: 'openrouter', models: ['text-extra'] },
        image: { provider: 'openrouter', models: ['image-extra'] },
      },
    );

    const results = await classifier.additionalSignals?.(
      cachedMessage({
        attachments: [
          {
            id: 'current',
            name: 'current.png',
            contentType: 'image/png',
            url: 'https://cdn.test/image.png',
            dataUrl: 'data:image/png;base64,Y3VycmVudA==',
          },
        ] as any,
      }),
      classifierContext(),
    );

    expect(results).toEqual([
      expect.objectContaining({
        modelId: 'image-extra',
        rationale: 'image second opinion',
      }),
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('image-extra');
    expect(body.messages[1].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]),
    );
  });

  it('turns OpenRouter failures into review reasons with rate-limit hints', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '12' },
      }),
    );
    const classifier = new OpenRouterScamClassifier(
      {
        get: vi.fn(async () => ({
          provider: 'openrouter',
          modelId: 'model',
          apiKey: 'key',
          apiKeyHint: null,
        })),
      } as any,
      immediateQueue(),
    );

    const result = await classifier.classify(
      cachedMessage(),
      classifierContext(),
    );
    expect(result.verdict).toBe('needs_review');
    expect(result.rationale).toContain('HTTP 429');
    expect(result.rationale).toContain('Retry after 12s');
  });
});

describe('OpenRouterEmbeddings', () => {
  it('requests text and image embeddings with configured dimensions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
          status: 200,
        }),
    );
    const embedder = new OpenRouterEmbeddings(
      {
        get: vi.fn(async () => ({
          provider: 'openrouter',
          modelId: 'embed-model',
          apiKey: 'key',
          apiKeyHint: null,
        })),
      } as any,
      immediateQueue(),
      3,
    );

    await expect(embedder.embedText('guild', 'free nitro')).resolves.toEqual({
      provider: 'openrouter',
      model: 'embed-model',
      dimensions: 3,
      vector: [1, 0, 0],
    });
    await expect(
      embedder.embedImage('guild', {
        contentType: 'image/png',
        name: 'proof.png',
        url: 'https://cdn.test/proof.png',
      }),
    ).resolves.toBeNull();
    await expect(
      embedder.embedImage('guild', {
        contentType: 'image/png',
        name: 'proof.png',
        url: 'https://cdn.test/proof.png',
        dataUrl: 'data:image/png;base64,cHJvb2Y=',
      }),
    ).resolves.toMatchObject({ vector: [1, 0, 0] });

    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    expect(bodies[0]).toMatchObject({
      model: 'embed-model',
      input: 'free nitro',
      dimensions: 3,
    });
    expect(bodies[1].input[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]),
    );
  });
});

describe('moderation actions', () => {
  it('applies and reverts policy actions at Discord boundaries', async () => {
    const member = fakeMember();
    const guild = fakeGuild(member);

    await expect(
      applyPolicyForUser(
        guild,
        'user',
        policy('timeout', { durationSeconds: 999999999 }),
        'reason',
      ),
    ).resolves.toEqual({ applied: true, detail: 'timeout applied' });
    expect(member.timeout).toHaveBeenCalledWith(
      28 * 24 * 60 * 60 * 1000,
      'reason',
    );
    await expect(
      applyPolicyForUser(
        guild,
        'user',
        policy('role', { roleId: 'role' }),
        'reason',
      ),
    ).resolves.toEqual({ applied: true, detail: 'role applied' });
    expect(member.roles.add).toHaveBeenCalledWith('role', 'reason');
    await expect(
      applyPolicyForUser(guild, 'user', policy('kick'), 'reason'),
    ).resolves.toEqual({ applied: true, detail: 'user kicked' });
    await expect(
      applyPolicyForUser(
        guild,
        'user',
        policy('ban', { deleteMessages: true }),
        'reason',
      ),
    ).resolves.toEqual({ applied: true, detail: 'user banned' });
    expect(guild.members.ban).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ deleteMessageSeconds: 604800 }),
    );

    await expect(
      revertPolicyForUser(guild, 'user', policy('timeout'), 'undo'),
    ).resolves.toBe('timeout removed');
    await expect(
      revertPolicyForUser(
        guild,
        'user',
        policy('role', { roleId: 'role' }),
        'undo',
      ),
    ).resolves.toBe('role removed');
    await expect(
      revertPolicyForUser(guild, 'user', policy('kick'), 'undo'),
    ).resolves.toBe('kick cannot be undone');
  });

  it('handles missing members, missing roles, and message deletion', async () => {
    const guild = fakeGuild(null);
    await expect(
      applyPolicyForUser(guild, 'user', policy('timeout'), 'reason'),
    ).resolves.toEqual({
      applied: false,
      detail:
        'timeout could not be applied because the member is no longer in the guild',
    });
    await expect(
      applyPolicyForUser(
        guild,
        'user',
        policy('role', { roleId: 'role' }),
        'reason',
      ),
    ).resolves.toEqual({
      applied: false,
      detail:
        'role could not be applied because the member is no longer in the guild',
    });
    await expect(
      applyPolicyForUser(guild, 'user', policy('kick'), 'reason'),
    ).resolves.toEqual({
      applied: false,
      detail:
        'kick could not be applied because the member is no longer in the guild',
    });
    await expect(
      applyPolicyForUser(guild, 'user', policy('role'), 'reason'),
    ).rejects.toThrow('missing role_id');
    await expect(
      revertPolicyForUser(guild, 'user', policy('role'), 'undo'),
    ).resolves.toBe('role policy had no role');

    await expect(
      deleteMessage({ deletable: false, delete: vi.fn() } as any),
    ).resolves.toBe(false);
    const deletable = { deletable: true, delete: vi.fn(async () => undefined) };
    await expect(deleteMessage(deletable as any)).resolves.toBe(true);
    expect(deletable.delete).toHaveBeenCalled();
  });

  it('sends Components V2 punishment DMs and records failures', async () => {
    const caseStore = {
      listCaseMessages: vi.fn(async () => [{ content: 'bad message' }]),
      listCaseAttachments: vi.fn(async () => [
        {
          id: 1,
          storageKey: 'stored.png',
          contentType: 'image/png',
          sizeBytes: 10,
          discordAttachmentId: 'att',
          name: 'proof.png',
          originalUrl: 'https://cdn.test/stored.png',
        },
        {
          id: 2,
          storageKey: null,
          contentType: 'image/png',
          sizeBytes: 10,
          discordAttachmentId: 'pending-att',
          name: 'pending.png',
          originalUrl: 'https://cdn.test/pending.png',
        },
      ]),
      addEvent: vi.fn(async () => undefined),
    };
    const member = fakeMember();
    await dmPunishedUser({
      member,
      caseId: 'case1',
      action: 'ban',
      reason: 'reason',
      caseStore: caseStore as any,
      storage: { pathFor: (key: string) => `/tmp/${key}` } as any,
    });
    expect(member.send).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: 1 << 15,
        components: expect.any(Array),
      }),
    );
    expect(JSON.stringify(member.send.mock.calls[0]?.[0])).not.toContain(
      'https://cdn.test/pending.png',
    );
    expect(caseStore.addEvent).toHaveBeenCalledWith(
      'case1',
      'dm_notified',
      'bot',
      null,
      'Punishment DM sent',
      { omitted: ['pending-att'] },
    );

    member.send.mockRejectedValueOnce(new Error('closed'));
    await dmPunishedUser({
      member,
      caseId: 'case1',
      action: 'kick',
      reason: 'reason',
      caseStore: caseStore as any,
      storage: { pathFor: (key: string) => `/tmp/${key}` } as any,
    });
    expect(caseStore.addEvent).toHaveBeenCalledWith(
      'case1',
      'failed',
      'bot',
      null,
      'Punishment DM failed',
      expect.objectContaining({ error: 'closed' }),
    );

    caseStore.listCaseMessages.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(
      dmPunishedUser({
        member,
        caseId: 'case1',
        action: 'ban',
        reason: 'reason',
        caseStore: caseStore as any,
        storage: { pathFor: (key: string) => `/tmp/${key}` } as any,
      }),
    ).resolves.toBe(false);
  });

  it('skips an unavailable DM but still bans a user who left the guild', async () => {
    const member = fakeMember();
    member.guild.members.fetch.mockRejectedValueOnce({
      code: RESTJSONErrorCodes.UnknownMember,
    });
    const caseStore = {
      listCaseMessages: vi.fn(async () => []),
      listCaseAttachments: vi.fn(async () => []),
      addEvent: vi.fn(async () => undefined),
    };

    await expect(
      applyPolicyWithBestEffortDm({
        guild: member.guild,
        userId: member.id,
        policy: policy('ban'),
        reason: 'audit reason',
        dm: {
          caseId: 'case1',
          reason: 'reason',
          caseStore: caseStore as any,
          storage: { pathFor: (key: string) => `/tmp/${key}` } as any,
        },
      }),
    ).resolves.toEqual({ applied: true, detail: 'user banned' });
    expect(member.guild.members.ban).toHaveBeenCalledOnce();
    expect(caseStore.addEvent).toHaveBeenCalledWith(
      'case1',
      'failed',
      'bot',
      null,
      'Punishment DM failed',
      expect.objectContaining({
        error: 'Cannot DM user because they are no longer in the guild',
      }),
    );
  });

  it('does not notify after a dispatched punishment fails', async () => {
    const member = fakeMember();
    member.guild.members.fetch.mockResolvedValueOnce(member);
    member.guild.members.ban.mockRejectedValueOnce(
      new Error('Discord response lost'),
    );

    await expect(
      applyPolicyWithBestEffortDm({
        guild: member.guild,
        userId: member.id,
        policy: policy('ban'),
        reason: 'audit reason',
        dm: {
          caseId: 'case1',
          reason: 'reason',
          caseStore: {
            listCaseMessages: vi.fn(),
            listCaseAttachments: vi.fn(),
            addEvent: vi.fn(),
          } as any,
          storage: { pathFor: (key: string) => `/tmp/${key}` } as any,
        },
      }),
    ).rejects.toThrow('Discord response lost');
    expect(member.send).not.toHaveBeenCalled();
  });

  it('records a transient DM lookup failure without blocking punishment', async () => {
    const member = fakeMember();
    member.guild.members.fetch.mockRejectedValueOnce(
      new Error('Discord unavailable'),
    );
    const caseStore = {
      listCaseMessages: vi.fn(),
      listCaseAttachments: vi.fn(),
      addEvent: vi.fn(async () => undefined),
    };

    await expect(
      applyPolicyWithBestEffortDm({
        guild: member.guild,
        userId: member.id,
        policy: policy('ban'),
        reason: 'audit reason',
        dm: {
          caseId: 'case1',
          reason: 'reason',
          caseStore: caseStore as any,
          storage: { pathFor: (key: string) => `/tmp/${key}` } as any,
        },
      }),
    ).resolves.toEqual({ applied: true, detail: 'user banned' });
    expect(member.guild.members.ban).toHaveBeenCalledOnce();
    expect(caseStore.addEvent).toHaveBeenCalledWith(
      'case1',
      'failed',
      'bot',
      null,
      'Punishment DM failed',
      expect.objectContaining({
        error: expect.stringContaining('Discord unavailable'),
      }),
    );
  });

  it.each(['case preparation', 'failure recording'] as const)(
    'keeps applied punishment successful when DM %s fails',
    async (failure) => {
      const member = fakeMember();
      const caseStore = {
        listCaseMessages: vi.fn(async () => []),
        listCaseAttachments: vi.fn(async () => []),
        addEvent: vi.fn(async () => undefined),
      };
      if (failure === 'case preparation') {
        caseStore.listCaseMessages.mockRejectedValueOnce(
          new Error('case unavailable'),
        );
      } else {
        member.send.mockRejectedValueOnce(new Error('closed'));
        caseStore.addEvent.mockRejectedValueOnce(
          new Error('database unavailable'),
        );
      }

      await expect(
        applyPolicyWithBestEffortDm({
          guild: member.guild,
          userId: member.id,
          policy: policy('ban'),
          reason: 'audit reason',
          dm: {
            caseId: 'case1',
            reason: 'reason',
            caseStore: caseStore as any,
            storage: { pathFor: (key: string) => `/tmp/${key}` } as any,
          },
        }),
      ).resolves.toEqual({ applied: true, detail: 'user banned' });
      expect(member.guild.members.ban).toHaveBeenCalledOnce();
    },
  );
});

describe('FileStorage and prompts', () => {
  it('stores downloaded files safely and removes them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'honeybot-storage-'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from('hello'), { status: 200 }),
    );
    const storage = new FileStorage(root);

    const stored = await storage.saveFromUrl(
      'https://cdn.test/file',
      ['guild', 'case'],
      '../bad name.txt',
    );
    expect(stored.storageKey).toMatch(
      /^guild\/case\/[a-f0-9]{64}-bad_name\.txt$/,
    );
    await expect(storage.read(stored.storageKey)).resolves.toEqual(
      Buffer.from('hello'),
    );
    await storage.remove(stored.storageKey);
    await expect(readFile(stored.path)).rejects.toThrow();
    await storage.remove(null);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects declared and streamed attachment bodies over the byte limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'honeybot-storage-'));
    const storage = new FileStorage(root, { maxAttachmentBytes: 8 });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(
      storage.saveFromUrl('https://cdn.test/declared', ['guild'], 'large.bin', {
        expectedSizeBytes: 9,
      }),
    ).rejects.toThrow('8 byte download limit');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.alloc(5));
            controller.enqueue(Buffer.alloc(5));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    await expect(
      storage.saveFromUrl('https://cdn.test/streamed', ['guild'], 'large.bin'),
    ).rejects.toThrow('8 byte download limit');

    rmSync(root, { recursive: true, force: true });
  });

  it('aborts attachment downloads that exceed the fetch deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'honeybot-storage-'));
    const storage = new FileStorage(root, { fetchTimeoutMs: 5 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error('Missing abort signal'));
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    await expect(
      storage.saveFromUrl('https://cdn.test/slow', ['guild'], 'slow.bin'),
    ).rejects.toBeInstanceOf(Error);

    rmSync(root, { recursive: true, force: true });
  });

  it('normalizes filename-identified model evidence images to webp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'honeybot-storage-'));
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>',
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(svg, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    const storage = new FileStorage(root);

    const stored = await storage.saveFromUrl(
      'https://cdn.test/image.png',
      ['guild', 'case'],
      'image.svg',
      { contentType: 'application/octet-stream' },
    );

    expect(stored.contentType).toBe('image/webp');
    expect(stored.fileName).toBe('image.webp');
    expect(stored.normalized).toBe(true);
    expect(stored.storageKey).toMatch(/\.webp$/);
    await expect(storage.read(stored.storageKey)).resolves.not.toEqual(svg);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects unsupported and over-pixel-limit images as metadata-only evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'honeybot-storage-'));
    const storage = new FileStorage(root, { image: { maxInputPixels: 1 } });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from('not an image'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    await expect(
      storage.saveFromUrl('https://cdn.test/bad', ['guild'], 'bad.png'),
    ).rejects.toThrow('Image could not be normalized safely');

    fetchMock.mockResolvedValueOnce(
      new Response(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>',
        ),
        {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        },
      ),
    );
    await expect(
      storage.saveFromUrl('https://cdn.test/large', ['guild'], 'large.svg'),
    ).rejects.toThrow('Image could not be normalized safely');

    rmSync(root, { recursive: true, force: true });
  });

  it('loads bundled classifier prompts', async () => {
    await expect(loadClassifierPrompt('scam-text')).resolves.toContain(
      'text classifier inside Honeybot',
    );
    await expect(loadClassifierPrompt('scam-text')).resolves.toContain(
      'always provide a non-empty `reason`',
    );
    await expect(loadClassifierPrompt('scam-image')).resolves.toContain(
      'multimodal classifier inside Honeybot',
    );
    await expect(loadClassifierPrompt('scam-image')).resolves.toContain(
      'always provide a non-empty `reason`',
    );
  });
});

describe('GlobalBanService', () => {
  it('bans joining users when their guild opted in', async () => {
    const database = testDatabase();
    database.sqlite
      .prepare(
        'insert into global_bans (id, user_id, published_by_user_id, status, reason, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('ban1', 'user', 'admin', 'active', 'bad', 'now', 'now');
    const configStore = {
      getGuildConfig: vi.fn(async () => ({ globalBansEnabled: true })),
    };
    const queue = {
      enqueue: vi.fn(async (_guildId: string, run: () => Promise<unknown>) =>
        run(),
      ),
    };
    const service = new GlobalBanService(
      database.db,
      configStore as any,
      queue as any,
    );
    const member = fakeMember();

    await service.handleJoin(member as any);

    expect(member.guild.members.ban).toHaveBeenCalledWith('user', {
      reason: 'Honeybot global ban: bad',
    });
    database.sqlite.close();
  });
});

function immediateQueue() {
  return {
    enqueue: async (_guildId: string, run: () => Promise<unknown>) => run(),
  } as any;
}

function classifierContext(overrides: Record<string, unknown> = {}) {
  return { evidenceSummary: '', proximalKnownScams: [], ...overrides } as any;
}

function cachedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message',
    guildId: 'guild',
    channelId: 'channel',
    authorId: 'user',
    content: 'free nitro',
    normalizedContent: 'free nitro',
    textHash: 'hash',
    attachments: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    reason: 'honeypot',
    ...overrides,
  } as any;
}

function caseInput(overrides: Partial<CaseReviewInput> = {}): CaseReviewInput {
  return {
    caseId: 'case1',
    userId: 'user',
    channelId: 'channel',
    triggerType: 'honeypot',
    duplicateChannelIds: [],
    moderatorUserIds: ['mod-user'],
    moderatorRoleIds: ['mod-role'],
    status: 'pending_review',
    reason: 'reason',
    messageContent: 'free nitro',
    attachments: [],
    storage: { pathFor: (key: string) => `/tmp/${key}` } as any,
    prevention: policy('timeout'),
    punishment: policy('ban'),
    preventionOutcome: {
      applied: true,
      detail: 'timeout applied',
      appliedAtMs: 1_700_000_000_000,
    },
    triggerMessageDeleted: true,
    punishmentReady: overrides.analysis !== null,
    analysis: {
      confidence: 0.88,
      reason: 'classifier',
      shouldPunish: false,
      evidence: [
        {
          type: 'classifier',
          matched: true,
          score: 0.88,
          summary: 'fake nitro',
          metadata: { verdict: 'scam' },
        },
      ],
    },
    ...overrides,
  };
}

function policy(actionType: any, overrides: Record<string, unknown> = {}) {
  return {
    scope: 'punishment',
    actionType,
    durationSeconds: 1_800,
    roleId: null,
    deleteMessages: true,
    ...overrides,
  } as any;
}

function fakeMember() {
  const member = {
    id: 'user',
    timeout: vi.fn(async () => undefined),
    kick: vi.fn(async () => undefined),
    roles: {
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    send: vi.fn(async () => undefined),
    guild: { id: 'guild', name: 'Guild', members: undefined as any },
  };
  member.guild.members = {
    fetch: vi.fn(async () => member),
    ban: vi.fn(async () => undefined),
    unban: vi.fn(async () => undefined),
  };
  return member as any;
}

function fakeGuild(member: any) {
  return {
    members: {
      fetch: vi.fn(async () => member),
      ban: vi.fn(async () => undefined),
      unban: vi.fn(async () => undefined),
    },
  } as any;
}

function collection(items: Array<any>) {
  return new Collection(
    items.map((item, index) => [item.id ?? `${item.name}-${index}`, item]),
  );
}

function textContent(components: Array<any>): string {
  const result: string[] = [];
  const visit = (component: any) => {
    if (typeof component.content === 'string') result.push(component.content);
    for (const child of component.components ?? []) visit(child);
  };
  for (const component of components) visit(component);
  return result.join('\n');
}

function componentByCustomId(
  components: Array<any>,
  customId: string,
): any | undefined {
  for (const component of components) {
    if (component.custom_id === customId) return component;
    const nested = componentByCustomId(component.components ?? [], customId);
    if (nested) return nested;
  }
  return undefined;
}

function customIds(components: Array<any>): string[] {
  const result: string[] = [];
  const visit = (component: any) => {
    if (typeof component.custom_id === 'string')
      result.push(component.custom_id);
    for (const child of component.components ?? []) visit(child);
  };
  for (const component of components) visit(component);
  return result;
}
