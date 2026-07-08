import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { models } from '../db/schema.js';
import { env } from '../env.js';
import type { ModelPurpose } from '../domain/types.js';

export type ModelConfig = {
  provider: string;
  modelId: string | null;
  apiKey: string | null;
  apiKeyHint: string | null;
};

export class ModelStore {
  constructor(private readonly db: Db) {}

  async get(guildId: string, purpose: ModelPurpose): Promise<ModelConfig> {
    const row = await this.db.select().from(models).where(and(eq(models.guildId, guildId), eq(models.purpose, purpose))).get();
    const provider = row?.provider ?? defaultProvider(purpose);
    return {
      provider,
      modelId: row?.modelId ?? defaultModel(purpose),
      apiKey: row?.encryptedApiKey ? decryptKey(row.encryptedApiKey, row.apiKeyNonce, row.apiKeyAuthTag) : defaultApiKey(provider),
      apiKeyHint: row?.apiKeyHint ?? hint(defaultApiKey(provider)),
    };
  }

  async setModel(guildId: string, purpose: ModelPurpose, provider: string, modelId: string | null) {
    const now = new Date().toISOString();
    await this.db
      .insert(models)
      .values({ guildId, purpose, provider, modelId, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [models.guildId, models.purpose], set: { provider, modelId, updatedAt: now } });
  }

  async setApiKey(guildId: string, purpose: ModelPurpose, apiKey: string) {
    const row = await this.db.select().from(models).where(and(eq(models.guildId, guildId), eq(models.purpose, purpose))).get();
    const encrypted = encryptKey(apiKey);
    const now = new Date().toISOString();
    await this.db
      .insert(models)
      .values({
        guildId,
        purpose,
        provider: row?.provider ?? defaultProvider(purpose),
        modelId: row?.modelId ?? defaultModel(purpose),
        encryptedApiKey: encrypted.encrypted,
        apiKeyNonce: encrypted.nonce,
        apiKeyAuthTag: encrypted.authTag,
        apiKeyHint: hint(apiKey),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [models.guildId, models.purpose],
        set: { encryptedApiKey: encrypted.encrypted, apiKeyNonce: encrypted.nonce, apiKeyAuthTag: encrypted.authTag, apiKeyHint: hint(apiKey), updatedAt: now },
      });
  }

  async clearApiKey(guildId: string, purpose: ModelPurpose) {
    await this.db
      .update(models)
      .set({ encryptedApiKey: null, apiKeyNonce: null, apiKeyAuthTag: null, apiKeyHint: null, updatedAt: new Date().toISOString() })
      .where(and(eq(models.guildId, guildId), eq(models.purpose, purpose)));
  }

  async list(guildId: string) {
    return this.db.select().from(models).where(eq(models.guildId, guildId));
  }
}

function defaultProvider(purpose: ModelPurpose) {
  switch (purpose) {
    case 'text_classifier':
      return env.DEFAULT_TEXT_CLASSIFIER_PROVIDER;
    case 'image_classifier':
      return env.DEFAULT_IMAGE_CLASSIFIER_PROVIDER;
    case 'text_embeddings':
      return env.DEFAULT_TEXT_EMBEDDINGS_PROVIDER;
    case 'image_embeddings':
      return env.DEFAULT_IMAGE_EMBEDDINGS_PROVIDER;
  }
}

function defaultModel(purpose: ModelPurpose) {
  switch (purpose) {
    case 'text_classifier':
      return env.DEFAULT_TEXT_CLASSIFIER_MODEL ?? null;
    case 'image_classifier':
      return env.DEFAULT_IMAGE_CLASSIFIER_MODEL ?? null;
    case 'text_embeddings':
      return env.DEFAULT_TEXT_EMBEDDINGS_MODEL;
    case 'image_embeddings':
      return env.DEFAULT_IMAGE_EMBEDDINGS_MODEL;
  }
}

function defaultApiKey(provider: string) {
  return provider === 'openrouter' ? (env.OPENROUTER_API_KEY ?? null) : null;
}

function encryptKey(apiKey: string) {
  const key = encryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return { encrypted: encrypted.toString('base64'), nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

function decryptKey(encrypted: string, nonce: string | null, authTag: string | null) {
  if (!nonce || !authTag) return null;
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

function encryptionKey() {
  if (!env.API_KEY_ENCRYPTION_KEY) throw new Error('API_KEY_ENCRYPTION_KEY is required for BYOK storage');
  const key = Buffer.from(env.API_KEY_ENCRYPTION_KEY, 'base64');
  if (key.byteLength !== 32) throw new Error('API_KEY_ENCRYPTION_KEY must be base64 encoded 32 bytes');
  return key;
}

function hint(apiKey: string | null) {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 4)}${'*'.repeat(Math.max(4, apiKey.length - 8))}${apiKey.slice(-4)}`;
}
