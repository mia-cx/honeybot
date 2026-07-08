import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { honeypots, models, moderators, policies, settings } from '../db/schema.js';
import { clonePolicies, defaultGuildConfig, defaultSettings } from '../domain/defaults.js';
import { policyScopes, type GuildConfig, type GuildSettings, type Policy, type PolicyScope } from '../domain/types.js';

const settingKeys = {
  moderationChannelId: 'moderation:channel_id',
  crosschannelEnabled: 'crosschannel:enabled',
  crosschannelWindowSeconds: 'crosschannel:window_seconds',
  crosschannelChannelThreshold: 'crosschannel:channel_threshold',
  knownImageSimilarityThreshold: 'known_image:similarity_threshold',
  knownTextSimilarityThreshold: 'known_text:similarity_threshold',
  evidenceConfidenceThreshold: 'evidence:confidence_threshold',
  reviewBypassEnabled: 'review:bypass_enabled',
  punishmentDmNotify: 'punishment:dm_notify',
  retentionCaseDays: 'retention:case_days',
  crosschannelMaxEntriesPerGuild: 'crosschannel:max_entries_per_guild',
  crosschannelMaxEntriesPerUser: 'crosschannel:max_entries_per_user',
  globalBansEnabled: 'global_bans:enabled',
} satisfies Record<keyof GuildSettings, string>;

const reverseSettingKeys = new Map(Object.entries(settingKeys).map(([key, value]) => [value, key as keyof GuildSettings]));
const guildDefaultsInitializedKey = 'defaults:initialized_at';
const guildRemovedAtKey = 'guild:removed_at';
export const removedGuildSettingsRetentionMs = 30 * 24 * 60 * 60 * 1000;

export class ConfigStore {
  constructor(
    private readonly db: Db,
    private readonly defaults: GuildConfig = defaultGuildConfig(),
  ) {}

  async getGuildConfig(guildId: string): Promise<GuildConfig> {
    const [settingRows, policyRows, honeypotRows, moderatorRows] = await Promise.all([
      this.db.select().from(settings).where(eq(settings.guildId, guildId)),
      this.db.select().from(policies).where(eq(policies.guildId, guildId)),
      this.db.select().from(honeypots).where(eq(honeypots.guildId, guildId)),
      this.db.select().from(moderators).where(eq(moderators.guildId, guildId)),
    ]);

    const initialized = settingRows.some((row) => row.key === guildDefaultsInitializedKey);
    const parsedSettings = settingsFromConfig(this.defaults);
    for (const row of settingRows) {
      const key = reverseSettingKeys.get(row.key);
      if (!key) continue;
      parsedSettings[key] = parseSettingValue(key, row.value) as never;
    }

    const parsedPolicies = clonePolicies(this.defaults.policies);
    for (const row of policyRows) {
      if (!isPolicyScope(row.scope)) continue;
      parsedPolicies[row.scope] = {
        scope: row.scope,
        actionType: row.actionType as Policy['actionType'],
        durationSeconds: row.durationSeconds,
        roleId: row.roleId,
        deleteMessages: row.deleteMessages === 1,
      };
    }

    const storedHoneypotIds = honeypotRows.map((row) => row.channelId);
    const storedModeratorUsers = moderatorRows.filter((row) => row.type === 'user').map((row) => row.id);
    const storedModeratorRoles = moderatorRows.filter((row) => row.type === 'role').map((row) => row.id);
    const hasStoredModerators = moderatorRows.length > 0;

    return defaultGuildConfig({
      ...parsedSettings,
      policies: parsedPolicies,
      honeypotChannelIds: initialized || storedHoneypotIds.length > 0 ? storedHoneypotIds : this.defaults.honeypotChannelIds,
      moderatorUsers: initialized || hasStoredModerators ? storedModeratorUsers : this.defaults.moderatorUsers,
      moderatorRoles: initialized || hasStoredModerators ? storedModeratorRoles : this.defaults.moderatorRoles,
    });
  }

  async initializeGuildDefaults(guildId: string) {
    const [existingSettingRows, existingPolicyRows, existingHoneypotRows, existingModeratorRows] = await Promise.all([
      this.db.select().from(settings).where(eq(settings.guildId, guildId)),
      this.db.select().from(policies).where(eq(policies.guildId, guildId)),
      this.db.select().from(honeypots).where(eq(honeypots.guildId, guildId)),
      this.db.select().from(moderators).where(eq(moderators.guildId, guildId)),
    ]);
    const isAlreadyInitialized =
      existingSettingRows.some((row) => row.key === guildDefaultsInitializedKey) ||
      existingSettingRows.some((row) => row.key !== guildRemovedAtKey) ||
      existingPolicyRows.length > 0 ||
      existingHoneypotRows.length > 0 ||
      existingModeratorRows.length > 0;
    await this.markGuildActive(guildId);
    const now = new Date().toISOString();
    const defaultSettingsForGuild = settingsFromConfig(this.defaults);

    await this.db
      .insert(settings)
      .values([
        ...Object.entries(settingKeys).map(([key, settingKey]) => ({
          guildId,
          key: settingKey,
          value: serializeSettingValue(defaultSettingsForGuild[key as keyof GuildSettings]),
          updatedAt: now,
        })),
        { guildId, key: guildDefaultsInitializedKey, value: now, updatedAt: now },
      ])
      .onConflictDoNothing();

    await this.db
      .insert(policies)
      .values(
        Object.values(this.defaults.policies).map((policy) => ({
          guildId,
          scope: policy.scope,
          actionType: policy.actionType,
          durationSeconds: policy.durationSeconds,
          roleId: policy.roleId,
          deleteMessages: policy.deleteMessages ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing();

    if (!isAlreadyInitialized && this.defaults.honeypotChannelIds.length > 0) {
      await this.db
        .insert(honeypots)
        .values(this.defaults.honeypotChannelIds.map((channelId) => ({ guildId, channelId, createdAt: now })))
        .onConflictDoNothing();
    }

    const defaultModerators = [
      ...this.defaults.moderatorUsers.map((id) => ({ guildId, type: 'user' as const, id, createdAt: now })),
      ...this.defaults.moderatorRoles.map((id) => ({ guildId, type: 'role' as const, id, createdAt: now })),
    ];
    if (!isAlreadyInitialized && defaultModerators.length > 0) {
      await this.db.insert(moderators).values(defaultModerators).onConflictDoNothing();
    }
  }

  async markGuildRemoved(guildId: string) {
    const now = new Date().toISOString();
    await this.db
      .insert(settings)
      .values({ guildId, key: guildRemovedAtKey, value: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.guildId, settings.key],
        set: { value: now, updatedAt: now },
      });
  }

  async purgeExpiredRemovedGuildSettings(now = new Date()) {
    const cutoff = new Date(now.getTime() - removedGuildSettingsRetentionMs).toISOString();
    const expiredRows = await this.db.select().from(settings).where(and(eq(settings.key, guildRemovedAtKey), lte(settings.value, cutoff)));
    const expiredGuildIds = [...new Set(expiredRows.map((row) => row.guildId))];

    for (const guildId of expiredGuildIds) {
      await Promise.all([
        this.db.delete(settings).where(eq(settings.guildId, guildId)),
        this.db.delete(policies).where(eq(policies.guildId, guildId)),
        this.db.delete(honeypots).where(eq(honeypots.guildId, guildId)),
        this.db.delete(moderators).where(eq(moderators.guildId, guildId)),
        this.db.delete(models).where(eq(models.guildId, guildId)),
      ]);
    }

    return expiredGuildIds.length;
  }

  async setSetting(guildId: string, key: keyof GuildSettings, value: GuildSettings[typeof key]) {
    const now = new Date().toISOString();
    await this.db
      .insert(settings)
      .values({ guildId, key: settingKeys[key], value: serializeSettingValue(value), updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.guildId, settings.key],
        set: { value: serializeSettingValue(value), updatedAt: now },
      });
  }

  async setPolicy(guildId: string, policy: Policy) {
    const now = new Date().toISOString();
    await this.db
      .insert(policies)
      .values({
        guildId,
        scope: policy.scope,
        actionType: policy.actionType,
        durationSeconds: policy.durationSeconds,
        roleId: policy.roleId,
        deleteMessages: policy.deleteMessages ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [policies.guildId, policies.scope],
        set: {
          actionType: policy.actionType,
          durationSeconds: policy.durationSeconds,
          roleId: policy.roleId,
          deleteMessages: policy.deleteMessages ? 1 : 0,
          updatedAt: now,
        },
      });
  }

  async addHoneypot(guildId: string, channelId: string) {
    await this.db
      .insert(honeypots)
      .values({ guildId, channelId, createdAt: new Date().toISOString() })
      .onConflictDoNothing();
  }

  async removeHoneypot(guildId: string, channelId: string) {
    await this.markGuildDefaultsInitialized(guildId);
    await this.db.delete(honeypots).where(and(eq(honeypots.guildId, guildId), eq(honeypots.channelId, channelId)));
  }

  async setHoneypots(guildId: string, channelIds: string[]) {
    await this.markGuildDefaultsInitialized(guildId);
    await this.db.delete(honeypots).where(eq(honeypots.guildId, guildId));
    const now = new Date().toISOString();
    const uniqueIds = [...new Set(channelIds)];
    if (uniqueIds.length === 0) return;
    await this.db.insert(honeypots).values(uniqueIds.map((channelId) => ({ guildId, channelId, createdAt: now })));
  }

  async addModerator(guildId: string, type: 'user' | 'role', id: string) {
    await this.db
      .insert(moderators)
      .values({ guildId, type, id, createdAt: new Date().toISOString() })
      .onConflictDoNothing();
  }

  async removeModerator(guildId: string, type: 'user' | 'role', id: string) {
    await this.markGuildDefaultsInitialized(guildId);
    await this.db.delete(moderators).where(and(eq(moderators.guildId, guildId), eq(moderators.type, type), eq(moderators.id, id)));
  }

  async setModerators(guildId: string, type: 'user' | 'role', ids: string[]) {
    await this.markGuildDefaultsInitialized(guildId);
    await this.db.delete(moderators).where(and(eq(moderators.guildId, guildId), eq(moderators.type, type)));
    const now = new Date().toISOString();
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;
    await this.db.insert(moderators).values(uniqueIds.map((id) => ({ guildId, type, id, createdAt: now })));
  }

  private async markGuildDefaultsInitialized(guildId: string) {
    const now = new Date().toISOString();
    await this.db.insert(settings).values({ guildId, key: guildDefaultsInitializedKey, value: now, updatedAt: now }).onConflictDoNothing();
  }

  private async markGuildActive(guildId: string) {
    await this.db.delete(settings).where(and(eq(settings.guildId, guildId), eq(settings.key, guildRemovedAtKey)));
  }
}

export function formatConfig(config: GuildConfig) {
  return [
    `moderation channel: ${config.moderationChannelId ?? 'unset'}`,
    `honeypots: ${config.honeypotChannelIds.length}`,
    `crosschannel: ${config.crosschannelEnabled ? 'on' : 'off'} (${config.crosschannelChannelThreshold} channels/${config.crosschannelWindowSeconds}s)`,
    `review bypass: ${config.reviewBypassEnabled ? 'on' : 'off'}`,
    `punishment: ${formatPolicy(config.policies.punishment)}`,
    `dm notify: ${config.punishmentDmNotify ? 'on' : 'off'}`,
  ].join('\n');
}

export function formatPolicy(policy: Policy) {
  const duration = policy.durationSeconds ? ` ${policy.durationSeconds}s` : '';
  const role = policy.roleId ? ` role:${policy.roleId}` : '';
  return `${policy.actionType}${duration}${role}${policy.deleteMessages ? ' + delete' : ''}`;
}

function settingsFromConfig(config: GuildConfig): GuildSettings {
  return {
    moderationChannelId: config.moderationChannelId,
    crosschannelEnabled: config.crosschannelEnabled,
    crosschannelWindowSeconds: config.crosschannelWindowSeconds,
    crosschannelChannelThreshold: config.crosschannelChannelThreshold,
    knownImageSimilarityThreshold: config.knownImageSimilarityThreshold,
    knownTextSimilarityThreshold: config.knownTextSimilarityThreshold,
    evidenceConfidenceThreshold: config.evidenceConfidenceThreshold,
    reviewBypassEnabled: config.reviewBypassEnabled,
    punishmentDmNotify: config.punishmentDmNotify,
    retentionCaseDays: config.retentionCaseDays,
    crosschannelMaxEntriesPerGuild: config.crosschannelMaxEntriesPerGuild,
    crosschannelMaxEntriesPerUser: config.crosschannelMaxEntriesPerUser,
    globalBansEnabled: config.globalBansEnabled,
  };
}

function parseSettingValue(key: keyof GuildSettings, value: string): GuildSettings[typeof key] {
  const defaultValue = defaultSettings[key];
  if (typeof defaultValue === 'boolean') return (value === 'true') as never;
  if (typeof defaultValue === 'number') return Number(value) as never;
  return (value === '' ? null : value) as never;
}

function serializeSettingValue(value: GuildSettings[keyof GuildSettings]) {
  return value === null ? '' : String(value);
}

function isPolicyScope(value: string): value is PolicyScope {
  return (policyScopes as readonly string[]).includes(value);
}
