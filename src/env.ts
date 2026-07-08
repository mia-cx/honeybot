import 'dotenv/config';
import { Schema } from 'effect';
import { defaultGuildConfig } from './domain/defaults.js';
import { preventionActions, punishmentActions, type GuildConfig, type Policy, type PolicyAction } from './domain/types.js';

const LogLevel = Schema.Literals(['debug', 'info', 'warn', 'error']);
const AuthMode = Schema.Literals(['team', 'users']);
const ImageStorageDriver = Schema.Literal('filesystem');
const OptionalString = Schema.optionalKey(Schema.String);
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Threshold = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const OptionalStringArray = Schema.optionalKey(Schema.Array(Schema.String));
const OptionalStringValue = Schema.optionalKey(Schema.String);
const OptionalBoolean = Schema.optionalKey(Schema.Boolean);
const OptionalPositiveInteger = Schema.optionalKey(PositiveInteger);
const OptionalThreshold = Schema.optionalKey(Threshold);
const OptionalNonNegativeIntegerOrNull = Schema.optionalKey(Schema.Union([NonNegativeInteger, Schema.Null]));
const OptionalPreventionAction = Schema.optionalKey(Schema.Literals(preventionActions));
const OptionalPunishmentAction = Schema.optionalKey(Schema.Literals(punishmentActions));

const EnvSchema = Schema.Struct({
  DISCORD_TOKEN: Schema.String,
  LOG_LEVEL: LogLevel,
  DATABASE_URL: Schema.String,
  IMAGE_STORAGE_DRIVER: ImageStorageDriver,
  IMAGE_STORAGE_DIR: Schema.String,
  API_KEY_ENCRYPTION_KEY: OptionalString,
  OPENROUTER_API_KEY: OptionalString,
  DEFAULT_TEXT_CLASSIFIER_PROVIDER: Schema.String,
  DEFAULT_TEXT_CLASSIFIER_MODEL: OptionalString,
  DEFAULT_IMAGE_CLASSIFIER_PROVIDER: Schema.String,
  DEFAULT_IMAGE_CLASSIFIER_MODEL: OptionalString,
  DEFAULT_TEXT_EMBEDDINGS_PROVIDER: Schema.String,
  DEFAULT_TEXT_EMBEDDINGS_MODEL: Schema.String,
  DEFAULT_IMAGE_EMBEDDINGS_PROVIDER: Schema.String,
  DEFAULT_IMAGE_EMBEDDINGS_MODEL: Schema.String,
  DEFAULT_EMBEDDINGS_DIMENSIONS: PositiveInteger,
  MODEL_CALL_LIMIT: PositiveInteger,
  MODEL_CALL_LIMIT_PER_GUILD: PositiveInteger,
  MODEL_CALL_WINDOW_SECONDS: PositiveInteger,
  MODEL_RETRY_MAX_ATTEMPTS: PositiveInteger,
  MODEL_RETRY_INITIAL_DELAY_MS: PositiveInteger,
  MODEL_RETRY_MAX_DELAY_MS: PositiveInteger,
  MODERATION_ACTION_LIMIT: PositiveInteger,
  MODERATION_ACTION_LIMIT_PER_GUILD: PositiveInteger,
  MODERATION_ACTION_WINDOW_SECONDS: PositiveInteger,
  EVAL_CORPUS_DIR: OptionalString,
  GLOBAL_AUTH_MODE: AuthMode,
  GLOBAL_AUTH_TEAM_ID: OptionalString,
  GLOBAL_AUTH_USER_IDS: Schema.String,

  HONEYBOT_DEFAULT_MODERATION_CHANNEL_ID: OptionalStringValue,
  HONEYBOT_DEFAULT_HONEYPOT_CHANNEL_IDS: OptionalStringArray,
  HONEYBOT_DEFAULT_MODERATOR_USER_IDS: OptionalStringArray,
  HONEYBOT_DEFAULT_MODERATOR_ROLE_IDS: OptionalStringArray,
  HONEYBOT_DEFAULT_CROSSCHANNEL_ENABLED: OptionalBoolean,
  HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_SECONDS: OptionalPositiveInteger,
  HONEYBOT_DEFAULT_CROSSCHANNEL_CHANNEL_THRESHOLD: OptionalPositiveInteger,
  HONEYBOT_DEFAULT_KNOWN_IMAGE_SIMILARITY_THRESHOLD: OptionalThreshold,
  HONEYBOT_DEFAULT_KNOWN_TEXT_SIMILARITY_THRESHOLD: OptionalThreshold,
  HONEYBOT_DEFAULT_EVIDENCE_CONFIDENCE_THRESHOLD: OptionalThreshold,
  HONEYBOT_DEFAULT_AUTO_PUNISH_ENABLED: OptionalBoolean,
  HONEYBOT_DEFAULT_PUNISHMENT_DM_NOTIFY: OptionalBoolean,
  HONEYBOT_DEFAULT_RETENTION_CASE_DAYS: OptionalPositiveInteger,
  HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_GUILD: OptionalPositiveInteger,
  HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_USER: OptionalPositiveInteger,
  HONEYBOT_DEFAULT_GLOBAL_BANS_ENABLED: OptionalBoolean,

  HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ACTION: OptionalPreventionAction,
  HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DURATION_SECONDS: OptionalNonNegativeIntegerOrNull,
  HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ROLE_ID: OptionalStringValue,
  HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DELETE_MESSAGES: OptionalBoolean,
  HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ACTION: OptionalPreventionAction,
  HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DURATION_SECONDS: OptionalNonNegativeIntegerOrNull,
  HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ROLE_ID: OptionalStringValue,
  HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DELETE_MESSAGES: OptionalBoolean,
  HONEYBOT_DEFAULT_PUNISHMENT_ACTION: OptionalPunishmentAction,
  HONEYBOT_DEFAULT_PUNISHMENT_DURATION_SECONDS: OptionalNonNegativeIntegerOrNull,
  HONEYBOT_DEFAULT_PUNISHMENT_ROLE_ID: OptionalStringValue,
  HONEYBOT_DEFAULT_PUNISHMENT_DELETE_MESSAGES: OptionalBoolean,
});

export const env = Schema.decodeUnknownSync(EnvSchema)(normalizeEnv(process.env));

const codeDefaults = defaultGuildConfig();

export const deploymentGuildDefaults: GuildConfig = defaultGuildConfig({
  moderationChannelId: env.HONEYBOT_DEFAULT_MODERATION_CHANNEL_ID ?? codeDefaults.moderationChannelId,
  crosschannelEnabled: env.HONEYBOT_DEFAULT_CROSSCHANNEL_ENABLED ?? codeDefaults.crosschannelEnabled,
  crosschannelWindowSeconds: env.HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_SECONDS ?? codeDefaults.crosschannelWindowSeconds,
  crosschannelChannelThreshold: env.HONEYBOT_DEFAULT_CROSSCHANNEL_CHANNEL_THRESHOLD ?? codeDefaults.crosschannelChannelThreshold,
  knownImageSimilarityThreshold: env.HONEYBOT_DEFAULT_KNOWN_IMAGE_SIMILARITY_THRESHOLD ?? codeDefaults.knownImageSimilarityThreshold,
  knownTextSimilarityThreshold: env.HONEYBOT_DEFAULT_KNOWN_TEXT_SIMILARITY_THRESHOLD ?? codeDefaults.knownTextSimilarityThreshold,
  evidenceConfidenceThreshold: env.HONEYBOT_DEFAULT_EVIDENCE_CONFIDENCE_THRESHOLD ?? codeDefaults.evidenceConfidenceThreshold,
  reviewBypassEnabled: env.HONEYBOT_DEFAULT_AUTO_PUNISH_ENABLED ?? codeDefaults.reviewBypassEnabled,
  punishmentDmNotify: env.HONEYBOT_DEFAULT_PUNISHMENT_DM_NOTIFY ?? codeDefaults.punishmentDmNotify,
  retentionCaseDays: env.HONEYBOT_DEFAULT_RETENTION_CASE_DAYS ?? codeDefaults.retentionCaseDays,
  crosschannelMaxEntriesPerGuild: env.HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_GUILD ?? codeDefaults.crosschannelMaxEntriesPerGuild,
  crosschannelMaxEntriesPerUser: env.HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_USER ?? codeDefaults.crosschannelMaxEntriesPerUser,
  globalBansEnabled: env.HONEYBOT_DEFAULT_GLOBAL_BANS_ENABLED ?? codeDefaults.globalBansEnabled,
  honeypotChannelIds: [...(env.HONEYBOT_DEFAULT_HONEYPOT_CHANNEL_IDS ?? codeDefaults.honeypotChannelIds)],
  moderatorUsers: [...(env.HONEYBOT_DEFAULT_MODERATOR_USER_IDS ?? codeDefaults.moderatorUsers)],
  moderatorRoles: [...(env.HONEYBOT_DEFAULT_MODERATOR_ROLE_IDS ?? codeDefaults.moderatorRoles)],
  policies: {
    honeypot_prevention: policyDefaults(codeDefaults.policies.honeypot_prevention, {
      actionType: env.HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ACTION,
      durationSeconds: env.HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DURATION_SECONDS,
      roleId: env.HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ROLE_ID,
      deleteMessages: env.HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DELETE_MESSAGES,
    }),
    crosschannel_prevention: policyDefaults(codeDefaults.policies.crosschannel_prevention, {
      actionType: env.HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ACTION,
      durationSeconds: env.HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DURATION_SECONDS,
      roleId: env.HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ROLE_ID,
      deleteMessages: env.HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DELETE_MESSAGES,
    }),
    punishment: policyDefaults(codeDefaults.policies.punishment, {
      actionType: env.HONEYBOT_DEFAULT_PUNISHMENT_ACTION,
      durationSeconds: env.HONEYBOT_DEFAULT_PUNISHMENT_DURATION_SECONDS,
      roleId: env.HONEYBOT_DEFAULT_PUNISHMENT_ROLE_ID,
      deleteMessages: env.HONEYBOT_DEFAULT_PUNISHMENT_DELETE_MESSAGES,
    }),
  },
});

type PolicyDefaultOverrides = {
  actionType: PolicyAction | undefined;
  durationSeconds: number | null | undefined;
  roleId: string | undefined;
  deleteMessages: boolean | undefined;
};

function policyDefaults(base: Policy, overrides: PolicyDefaultOverrides): Policy {
  return {
    scope: base.scope,
    actionType: overrides.actionType ?? base.actionType,
    durationSeconds: overrides.durationSeconds !== undefined ? overrides.durationSeconds : base.durationSeconds,
    roleId: overrides.roleId ?? base.roleId,
    deleteMessages: overrides.deleteMessages ?? base.deleteMessages,
  };
}

function normalizeEnv(raw: NodeJS.ProcessEnv): Record<string, unknown> {
  return compact({
    DISCORD_TOKEN: requiredString(raw.DISCORD_TOKEN, 'DISCORD_TOKEN'),
    LOG_LEVEL: stringDefault(raw.LOG_LEVEL, 'info'),
    DATABASE_URL: stringDefault(raw.DATABASE_URL, 'file:data/honeybot.sqlite'),
    IMAGE_STORAGE_DRIVER: stringDefault(raw.IMAGE_STORAGE_DRIVER, 'filesystem'),
    IMAGE_STORAGE_DIR: stringDefault(raw.IMAGE_STORAGE_DIR, 'data/images'),
    API_KEY_ENCRYPTION_KEY: optionalString(raw.API_KEY_ENCRYPTION_KEY),
    OPENROUTER_API_KEY: optionalString(raw.OPENROUTER_API_KEY),
    DEFAULT_TEXT_CLASSIFIER_PROVIDER: stringDefault(raw.DEFAULT_TEXT_CLASSIFIER_PROVIDER, 'openrouter'),
    DEFAULT_TEXT_CLASSIFIER_MODEL: optionalString(raw.DEFAULT_TEXT_CLASSIFIER_MODEL),
    DEFAULT_IMAGE_CLASSIFIER_PROVIDER: stringDefault(raw.DEFAULT_IMAGE_CLASSIFIER_PROVIDER, 'openrouter'),
    DEFAULT_IMAGE_CLASSIFIER_MODEL: optionalString(raw.DEFAULT_IMAGE_CLASSIFIER_MODEL),
    DEFAULT_TEXT_EMBEDDINGS_PROVIDER: stringDefault(raw.DEFAULT_TEXT_EMBEDDINGS_PROVIDER, 'openrouter'),
    DEFAULT_TEXT_EMBEDDINGS_MODEL: stringDefault(raw.DEFAULT_TEXT_EMBEDDINGS_MODEL, 'google/gemini-embedding-2'),
    DEFAULT_IMAGE_EMBEDDINGS_PROVIDER: stringDefault(raw.DEFAULT_IMAGE_EMBEDDINGS_PROVIDER, 'openrouter'),
    DEFAULT_IMAGE_EMBEDDINGS_MODEL: stringDefault(raw.DEFAULT_IMAGE_EMBEDDINGS_MODEL, 'google/gemini-embedding-2'),
    DEFAULT_EMBEDDINGS_DIMENSIONS: positiveInteger(raw.DEFAULT_EMBEDDINGS_DIMENSIONS, 1536),
    MODEL_CALL_LIMIT: positiveInteger(raw.MODEL_CALL_LIMIT, 60),
    MODEL_CALL_LIMIT_PER_GUILD: positiveInteger(raw.MODEL_CALL_LIMIT_PER_GUILD, 20),
    MODEL_CALL_WINDOW_SECONDS: positiveInteger(raw.MODEL_CALL_WINDOW_SECONDS, 60),
    MODEL_RETRY_MAX_ATTEMPTS: positiveInteger(raw.MODEL_RETRY_MAX_ATTEMPTS, 3),
    MODEL_RETRY_INITIAL_DELAY_MS: positiveInteger(raw.MODEL_RETRY_INITIAL_DELAY_MS, 500),
    MODEL_RETRY_MAX_DELAY_MS: positiveInteger(raw.MODEL_RETRY_MAX_DELAY_MS, 5000),
    MODERATION_ACTION_LIMIT: positiveInteger(raw.MODERATION_ACTION_LIMIT, 30),
    MODERATION_ACTION_LIMIT_PER_GUILD: positiveInteger(raw.MODERATION_ACTION_LIMIT_PER_GUILD, 10),
    MODERATION_ACTION_WINDOW_SECONDS: positiveInteger(raw.MODERATION_ACTION_WINDOW_SECONDS, 60),
    EVAL_CORPUS_DIR: optionalString(raw.EVAL_CORPUS_DIR),
    GLOBAL_AUTH_MODE: stringDefault(raw.GLOBAL_AUTH_MODE, 'users'),
    GLOBAL_AUTH_TEAM_ID: optionalString(raw.GLOBAL_AUTH_TEAM_ID),
    GLOBAL_AUTH_USER_IDS: stringDefault(raw.GLOBAL_AUTH_USER_IDS, ''),

    HONEYBOT_DEFAULT_MODERATION_CHANNEL_ID: optionalString(raw.HONEYBOT_DEFAULT_MODERATION_CHANNEL_ID),
    HONEYBOT_DEFAULT_HONEYPOT_CHANNEL_IDS: optionalCsv(raw.HONEYBOT_DEFAULT_HONEYPOT_CHANNEL_IDS),
    HONEYBOT_DEFAULT_MODERATOR_USER_IDS: optionalCsv(raw.HONEYBOT_DEFAULT_MODERATOR_USER_IDS),
    HONEYBOT_DEFAULT_MODERATOR_ROLE_IDS: optionalCsv(raw.HONEYBOT_DEFAULT_MODERATOR_ROLE_IDS),
    HONEYBOT_DEFAULT_CROSSCHANNEL_ENABLED: optionalBoolean(raw.HONEYBOT_DEFAULT_CROSSCHANNEL_ENABLED),
    HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_SECONDS: optionalPositiveInteger(raw.HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_SECONDS),
    HONEYBOT_DEFAULT_CROSSCHANNEL_CHANNEL_THRESHOLD: optionalPositiveInteger(raw.HONEYBOT_DEFAULT_CROSSCHANNEL_CHANNEL_THRESHOLD),
    HONEYBOT_DEFAULT_KNOWN_IMAGE_SIMILARITY_THRESHOLD: optionalThreshold(raw.HONEYBOT_DEFAULT_KNOWN_IMAGE_SIMILARITY_THRESHOLD),
    HONEYBOT_DEFAULT_KNOWN_TEXT_SIMILARITY_THRESHOLD: optionalThreshold(raw.HONEYBOT_DEFAULT_KNOWN_TEXT_SIMILARITY_THRESHOLD),
    HONEYBOT_DEFAULT_EVIDENCE_CONFIDENCE_THRESHOLD: optionalThreshold(raw.HONEYBOT_DEFAULT_EVIDENCE_CONFIDENCE_THRESHOLD),
    HONEYBOT_DEFAULT_AUTO_PUNISH_ENABLED: optionalBoolean(raw.HONEYBOT_DEFAULT_AUTO_PUNISH_ENABLED),
    HONEYBOT_DEFAULT_PUNISHMENT_DM_NOTIFY: optionalBoolean(raw.HONEYBOT_DEFAULT_PUNISHMENT_DM_NOTIFY),
    HONEYBOT_DEFAULT_RETENTION_CASE_DAYS: optionalPositiveInteger(raw.HONEYBOT_DEFAULT_RETENTION_CASE_DAYS),
    HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_GUILD: optionalPositiveInteger(raw.HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_GUILD),
    HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_USER: optionalPositiveInteger(raw.HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_USER),
    HONEYBOT_DEFAULT_GLOBAL_BANS_ENABLED: optionalBoolean(raw.HONEYBOT_DEFAULT_GLOBAL_BANS_ENABLED),

    HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ACTION: optionalString(raw.HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ACTION),
    HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DURATION_SECONDS: optionalNullableNonNegativeInteger(raw.HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DURATION_SECONDS),
    HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ROLE_ID: optionalString(raw.HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ROLE_ID),
    HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DELETE_MESSAGES: optionalBoolean(raw.HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DELETE_MESSAGES),
    HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ACTION: optionalString(raw.HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ACTION),
    HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DURATION_SECONDS: optionalNullableNonNegativeInteger(raw.HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DURATION_SECONDS),
    HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ROLE_ID: optionalString(raw.HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ROLE_ID),
    HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DELETE_MESSAGES: optionalBoolean(raw.HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DELETE_MESSAGES),
    HONEYBOT_DEFAULT_PUNISHMENT_ACTION: optionalString(raw.HONEYBOT_DEFAULT_PUNISHMENT_ACTION),
    HONEYBOT_DEFAULT_PUNISHMENT_DURATION_SECONDS: optionalNullableNonNegativeInteger(raw.HONEYBOT_DEFAULT_PUNISHMENT_DURATION_SECONDS),
    HONEYBOT_DEFAULT_PUNISHMENT_ROLE_ID: optionalString(raw.HONEYBOT_DEFAULT_PUNISHMENT_ROLE_ID),
    HONEYBOT_DEFAULT_PUNISHMENT_DELETE_MESSAGES: optionalBoolean(raw.HONEYBOT_DEFAULT_PUNISHMENT_DELETE_MESSAGES),
  });
}

function requiredString(value: string | undefined, name: string) {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function stringDefault(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function optionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInteger(value: string | undefined, fallback: number) {
  return optionalPositiveInteger(value) ?? fallback;
}

function optionalPositiveInteger(value: string | undefined) {
  return optionalInteger(value);
}

function optionalThreshold(value: string | undefined) {
  if (value?.trim() === '') return undefined;
  return value === undefined ? undefined : Number(value);
}

function optionalNullableNonNegativeInteger(value: string | undefined) {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'null' || trimmed === 'none') return null;
  return Number(trimmed);
}

function optionalInteger(value: string | undefined) {
  if (value?.trim() === '') return undefined;
  return value === undefined ? undefined : Number(value);
}

function optionalBoolean(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return value;
}

function optionalCsv(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function compact(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
