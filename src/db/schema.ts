import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable(
  'settings',
  {
    guildId: text('guild_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.guildId, table.key] }) }),
);

export const policies = sqliteTable(
  'policies',
  {
    guildId: text('guild_id').notNull(),
    scope: text('scope').notNull(),
    actionType: text('action_type').notNull(),
    durationSeconds: integer('duration_seconds'),
    roleId: text('role_id'),
    deleteMessages: integer('delete_messages').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.guildId, table.scope] }) }),
);

export const moderators = sqliteTable(
  'moderators',
  {
    guildId: text('guild_id').notNull(),
    type: text('type').notNull(),
    id: text('id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.type, table.id] }),
  }),
);

export const honeypots = sqliteTable(
  'honeypots',
  {
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.channelId] }),
  }),
);

export const models = sqliteTable(
  'models',
  {
    guildId: text('guild_id').notNull(),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    modelId: text('model_id'),
    encryptedApiKey: text('encrypted_api_key'),
    apiKeyHint: text('api_key_hint'),
    apiKeyNonce: text('api_key_nonce'),
    apiKeyAuthTag: text('api_key_auth_tag'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.guildId, table.purpose] }) }),
);

export const cases = sqliteTable('cases', {
  id: text('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  triggerType: text('trigger_type').notNull(),
  status: text('status').notNull(),
  actionTaken: text('action_taken'),
  reason: text('reason'),
  evidenceSummaryJson: text('evidence_summary_json').notNull(),
  reviewChannelId: text('review_channel_id'),
  reviewMessageId: text('review_message_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const caseMessages = sqliteTable('case_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  caseId: text('case_id').notNull(),
  messageId: text('message_id').notNull(),
  channelId: text('channel_id').notNull(),
  authorId: text('author_id').notNull(),
  content: text('content').notNull(),
  normalizedContent: text('normalized_content').notNull(),
  textHash: text('text_hash'),
  deleted: integer('deleted').notNull(),
  createdAt: text('created_at').notNull(),
});

export const caseAttachments = sqliteTable('case_attachments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  caseId: text('case_id').notNull(),
  caseMessageId: integer('case_message_id').notNull(),
  discordAttachmentId: text('discord_attachment_id').notNull(),
  name: text('name'),
  originalUrl: text('original_url').notNull(),
  reviewAttachmentUrl: text('review_attachment_url'),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256'),
  perceptualHash: text('perceptual_hash'),
  storageKey: text('storage_key'),
  createdAt: text('created_at').notNull(),
});

export const caseEvidence = sqliteTable('case_evidence', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  caseId: text('case_id').notNull(),
  evidenceType: text('evidence_type').notNull(),
  matched: integer('matched').notNull(),
  score: real('score').notNull(),
  summary: text('summary').notNull(),
  metadataJson: text('metadata_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const caseEvents = sqliteTable('case_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  caseId: text('case_id').notNull(),
  eventType: text('event_type').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  reason: text('reason'),
  metadataJson: text('metadata_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const evidenceReviews = sqliteTable('evidence_reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  status: text('status').notNull(),
  reviewerId: text('reviewer_id'),
  note: text('note'),
  reviewedAt: text('reviewed_at'),
  createdAt: text('created_at').notNull(),
});

export const knownTexts = sqliteTable('known_texts', {
  id: text('id').primaryKey(),
  normalizedText: text('normalized_text').notNull(),
  textHash: text('text_hash').notNull(),
  embeddingProvider: text('embedding_provider'),
  embeddingModel: text('embedding_model'),
  embeddingDimensions: integer('embedding_dimensions'),
  embeddingVectorJson: text('embedding_vector_json'),
  description: text('description').notNull(),
  scamReason: text('scam_reason').notNull(),
  sourceCaseId: text('source_case_id'),
  sourceDiscordMessageId: text('source_discord_message_id'),
  approvedBy: text('approved_by'),
  scope: text('scope').notNull(),
  guildId: text('guild_id'),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const knownImages = sqliteTable('known_images', {
  id: text('id').primaryKey(),
  sha256: text('sha256').notNull(),
  perceptualHash: text('perceptual_hash'),
  storageKey: text('storage_key').notNull(),
  embeddingProvider: text('embedding_provider'),
  embeddingModel: text('embedding_model'),
  embeddingDimensions: integer('embedding_dimensions'),
  embeddingVectorJson: text('embedding_vector_json'),
  description: text('description').notNull(),
  scamReason: text('scam_reason').notNull(),
  sourceCaseId: text('source_case_id'),
  sourceDiscordAttachmentId: text('source_discord_attachment_id'),
  approvedBy: text('approved_by'),
  scope: text('scope').notNull(),
  guildId: text('guild_id'),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const globalBans = sqliteTable('global_bans', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  sourceCaseId: text('source_case_id'),
  publishedByUserId: text('published_by_user_id').notNull(),
  status: text('status').notNull(),
  reason: text('reason').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
