import type { GuildConfig, GuildSettings, Policy, PolicyScope } from './types.js';

export const defaultSettings: GuildSettings = {
  moderationChannelId: null,
  crosschannelEnabled: true,
  crosschannelWindowSeconds: 60,
  crosschannelChannelThreshold: 2,
  knownImageSimilarityThreshold: 0.92,
  knownTextSimilarityThreshold: 0.82,
  evidenceConfidenceThreshold: 0.9,
  reviewBypassEnabled: false,
  punishmentDmNotify: true,
  retentionCaseDays: 180,
  crosschannelMaxEntriesPerGuild: 10_000,
  crosschannelMaxEntriesPerUser: 200,
  globalBansEnabled: false,
};

export const defaultPolicies: Record<PolicyScope, Policy> = {
  honeypot_prevention: {
    scope: 'honeypot_prevention',
    actionType: 'timeout',
    durationSeconds: 21_600,
    roleId: null,
    deleteMessages: true,
  },
  crosschannel_prevention: {
    scope: 'crosschannel_prevention',
    actionType: 'timeout',
    durationSeconds: 1_800,
    roleId: null,
    deleteMessages: true,
  },
  punishment: {
    scope: 'punishment',
    actionType: 'ban',
    durationSeconds: null,
    roleId: null,
    deleteMessages: true,
  },
};

export function defaultGuildConfig(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return {
    ...defaultSettings,
    policies: clonePolicies(defaultPolicies),
    honeypotChannelIds: [],
    moderatorUsers: [],
    moderatorRoles: [],
    ...overrides,
  };
}

export function clonePolicies(policies: Record<PolicyScope, Policy>): Record<PolicyScope, Policy> {
  return {
    honeypot_prevention: { ...policies.honeypot_prevention },
    crosschannel_prevention: { ...policies.crosschannel_prevention },
    punishment: { ...policies.punishment },
  };
}
