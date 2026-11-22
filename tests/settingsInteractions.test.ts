import type { Interaction } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleInteractionCreate,
  type InteractionDependencies,
} from '../src/events/interactionCreate.js';
import { ConfigStore } from '../src/services/configStore.js';
import { ModelStore } from '../src/services/modelStore.js';
import {
  settingsUpdate,
  type SettingsPage,
} from '../src/interactions/settingsUi.js';
import type { PolicyScope } from '../src/domain/types.js';
import { cleanupTempDirs, testDatabase, testModelDefaults } from './helpers.js';

afterEach(cleanupTempDirs);

function setup(customId: string, fields: Record<string, string>) {
  const database = testDatabase();
  const configStore = new ConfigStore(database.db);
  const modelStore = new ModelStore(database.db, testModelDefaults());
  const message = { components: ['original settings'] as unknown };
  const interaction = {
    customId,
    guildId: 'guild',
    user: { id: 'owner' },
    client: {},
    member: { id: 'owner', guild: { ownerId: 'owner' } },
    message,
    inCachedGuild: () => true,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isModalSubmit: () => true,
    isFromMessage: () => true,
    fields: { getTextInputValue: (key: string) => fields[key] ?? '' },
    reply: vi.fn(),
    followUp: vi.fn(),
    update: vi.fn(async (payload: { components: unknown }) => {
      message.components = payload.components;
    }),
  };
  const deps = { configStore, modelStore } as InteractionDependencies;
  return { interaction, deps, database };
}

describe('settings modal submissions', () => {
  it.each([
    [
      'scalar',
      'settings:modal:retentionCaseDays:config',
      { value: '42' },
      'config',
      'punishment',
    ],
    [
      'policy',
      'settings:policyModal:duration:crosschannel_prevention',
      { value: '6h' },
      'policies_prevention',
      'crosschannel_prevention',
    ],
    [
      'model',
      'settings:modelModal:text_classifier',
      { provider: 'openrouter', model_id: 'new-model' },
      'model_text_classifier',
      'punishment',
    ],
    [
      'API key',
      'settings:modelKeyModal:text_classifier',
      { api_key: 'new-test-key' },
      'model_text_classifier',
      'punishment',
    ],
    [
      'empty scalar',
      'settings:modal:retentionCaseDays:config',
      { value: '' },
      'config',
      'punishment',
    ],
    [
      'empty policy',
      'settings:policyModal:duration:honeypot_prevention',
      { value: '' },
      'policies_prevention',
      'honeypot_prevention',
    ],
    [
      'empty model',
      'settings:modelModal:image_classifier',
      { provider: 'openrouter', model_id: '' },
      'model_image_classifier',
      'punishment',
    ],
    [
      'empty API key',
      'settings:modelKeyModal:image_classifier',
      { api_key: '' },
      'model_image_classifier',
      'punishment',
    ],
  ] as const)(
    'updates the originating message for %s',
    async (kind, id, fields, page, scope) => {
      const { interaction, deps, database } = setup(id, fields);
      try {
        await handleInteractionCreate(
          interaction as unknown as Interaction,
          deps,
        );
        const config = await deps.configStore.getGuildConfig('guild');
        const model = await deps.modelStore.get('guild', 'text_classifier');
        if (kind === 'scalar') expect(config.retentionCaseDays).toBe(42);
        if (kind === 'policy')
          expect(config.policies.crosschannel_prevention.durationSeconds).toBe(
            21600,
          );
        if (kind === 'model') expect(model.modelId).toBe('new-model');
        if (kind === 'API key') expect(model.apiKey).toBe('new-test-key');
        if (kind === 'empty scalar') expect(config.retentionCaseDays).toBe(0);
        if (kind === 'empty policy')
          expect(
            config.policies.honeypot_prevention.durationSeconds,
          ).toBeNull();
        const models = await Promise.all(
          (
            [
              'text_classifier',
              'image_classifier',
              'text_embeddings',
              'image_embeddings',
            ] as const
          ).map(async (purpose) => ({
            purpose,
            ...(await deps.modelStore.get('guild', purpose)),
          })),
        );
        const expected = settingsUpdate(
          config,
          page as SettingsPage,
          scope as PolicyScope,
          models,
        );
        expect(interaction.update).toHaveBeenCalledExactlyOnceWith(expected);
        expect(interaction.message.components).toEqual(expected.components);
        expect(interaction.reply).not.toHaveBeenCalled();
        expect(interaction.followUp).not.toHaveBeenCalled();
      } finally {
        database.sqlite.close();
      }
    },
  );

  it.each([
    ['settings:modal:retentionCaseDays:config', { value: 'invalid' }],
    ['settings:policyModal:duration:punishment', { value: 'invalid' }],
    ['settings:modelModal:text_classifier', { provider: '' }],
    ['settings:modelKeyModal:unknown', { api_key: 'test' }],
  ])(
    'replies ephemerally without changing settings for %s',
    async (id, fields) => {
      const { interaction, deps, database } = setup(id, fields);
      try {
        const before = await deps.configStore.getGuildConfig('guild');
        await handleInteractionCreate(
          interaction as unknown as Interaction,
          deps,
        );
        expect(interaction.reply).toHaveBeenCalledExactlyOnceWith({
          content: expect.any(String),
          ephemeral: true,
        });
        expect(interaction.update).not.toHaveBeenCalled();
        expect(interaction.message.components).toEqual(['original settings']);
        expect(await deps.configStore.getGuildConfig('guild')).toEqual(before);
      } finally {
        database.sqlite.close();
      }
    },
  );

  it('rejects a modal without an originating message before saving', async () => {
    const { interaction, deps, database } = setup(
      'settings:modal:retentionCaseDays:config',
      { value: '42' },
    );
    interaction.isFromMessage = () => false;
    try {
      const before = await deps.configStore.getGuildConfig('guild');
      await handleInteractionCreate(
        interaction as unknown as Interaction,
        deps,
      );
      expect(interaction.reply).toHaveBeenCalledExactlyOnceWith({
        content: 'Please reopen settings and try again.',
        ephemeral: true,
      });
      expect(interaction.update).not.toHaveBeenCalled();
      expect(await deps.configStore.getGuildConfig('guild')).toEqual(before);
    } finally {
      database.sqlite.close();
    }
  });
});
