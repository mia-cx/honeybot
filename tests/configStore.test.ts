import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/db/database.js';
import { honeypots, models, moderators, policies, settings } from '../src/db/schema.js';
import { defaultGuildConfig } from '../src/domain/defaults.js';
import { ConfigStore } from '../src/services/configStore.js';
import { cleanupTempDirs, testDatabase } from './helpers.js';

afterEach(cleanupTempDirs);

describe('ConfigStore deployment defaults', () => {
  it('layers in-code defaults, deployment defaults, then per-guild settings', async () => {
    const database = testDatabase();
    const deploymentDefaults = defaultGuildConfig({
      crosschannelWindowSeconds: 90,
      honeypotChannelIds: ['honeypot-default'],
      moderatorRoles: ['mod-role-default'],
      policies: {
        ...defaultGuildConfig().policies,
        punishment: { ...defaultGuildConfig().policies.punishment, actionType: 'kick' },
      },
    });
    const store = new ConfigStore(database.db, deploymentDefaults);

    await store.initializeGuildDefaults('guild');
    expect(await store.getGuildConfig('guild')).toMatchObject({
      crosschannelWindowSeconds: 90,
      honeypotChannelIds: ['honeypot-default'],
      moderatorRoles: ['mod-role-default'],
      policies: { punishment: expect.objectContaining({ actionType: 'kick' }) },
    });

    await store.setSetting('guild', 'crosschannelWindowSeconds', 30);
    await store.setHoneypots('guild', []);
    expect(await store.getGuildConfig('guild')).toMatchObject({
      crosschannelWindowSeconds: 30,
      honeypotChannelIds: [],
      moderatorRoles: ['mod-role-default'],
    });

    database.sqlite.close();
  });

  it('retains removed guild settings for re-adds before purging after 30 days', async () => {
    const database = testDatabase();
    const store = new ConfigStore(database.db, defaultGuildConfig({ honeypotChannelIds: ['honeypot-default'] }));

    await store.initializeGuildDefaults('guild');
    await store.setSetting('guild', 'crosschannelWindowSeconds', 30);
    await store.setHoneypots('guild', []);
    await store.markGuildRemoved('guild');
    await store.initializeGuildDefaults('guild');

    expect(await store.getGuildConfig('guild')).toMatchObject({ crosschannelWindowSeconds: 30, honeypotChannelIds: [] });

    await store.markGuildRemoved('guild');
    await database.db.insert(models).values({ guildId: 'guild', purpose: 'text_classifier', provider: 'openrouter', modelId: 'model', encryptedApiKey: null, apiKeyHint: null, apiKeyNonce: null, apiKeyAuthTag: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const purged = await store.purgeExpiredRemovedGuildSettings(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));

    expect(purged).toBe(1);
    await expectConfigRows(database, 'guild', 0);
    database.sqlite.close();
  });
});

async function expectConfigRows(database: DatabaseHandle, guildId: string, count: number) {
  const rows = await Promise.all([
    database.db.select().from(settings).where(eq(settings.guildId, guildId)),
    database.db.select().from(policies).where(eq(policies.guildId, guildId)),
    database.db.select().from(honeypots).where(eq(honeypots.guildId, guildId)),
    database.db.select().from(moderators).where(eq(moderators.guildId, guildId)),
    database.db.select().from(models).where(eq(models.guildId, guildId)),
  ]);
  expect(rows.flat()).toHaveLength(count);
}


