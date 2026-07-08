import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { models } from '../db/schema.js';
import type { ModelPurpose } from '../domain/types.js';

export type ModelDefaults = Record<
  ModelPurpose,
  { provider: string; modelId: string | null }
> & {
  apiKeys?: Partial<Record<string, string | null>>;
  encryptionKeyBase64?: string | null;
};

export type ModelConfig = {
  provider: string;
  modelId: string | null;
  apiKey: string | null;
  apiKeyHint: string | null;
};

export class ModelStore {
  constructor(
    private readonly db: Db,
    private readonly defaults: ModelDefaults,
  ) {}

  async get(guildId: string, purpose: ModelPurpose): Promise<ModelConfig> {
    const row = await this.db
      .select()
      .from(models)
      .where(and(eq(models.guildId, guildId), eq(models.purpose, purpose)))
      .get();
    const provider = row?.provider ?? this.defaultProvider(purpose);
    return {
      provider,
      modelId: row?.modelId ?? this.defaultModel(purpose),
      apiKey: row?.encryptedApiKey
        ? decryptKey(
            row.encryptedApiKey,
            row.apiKeyNonce,
            row.apiKeyAuthTag,
            this.encryptionKey(),
          )
        : this.defaultApiKey(provider),
      apiKeyHint: row?.apiKeyHint ?? null,
    };
  }

  async setModel(
    guildId: string,
    purpose: ModelPurpose,
    provider: string,
    modelId: string | null,
  ) {
    const now = new Date().toISOString();
    await this.db
      .insert(models)
      .values({
        guildId,
        purpose,
        provider,
        modelId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [models.guildId, models.purpose],
        set: { provider, modelId, updatedAt: now },
      });
  }

  async setApiKey(guildId: string, purpose: ModelPurpose, apiKey: string) {
    const row = await this.db
      .select()
      .from(models)
      .where(and(eq(models.guildId, guildId), eq(models.purpose, purpose)))
      .get();
    const encrypted = encryptKey(apiKey, this.encryptionKey());
    const now = new Date().toISOString();
    await this.db
      .insert(models)
      .values({
        guildId,
        purpose,
        provider: row?.provider ?? this.defaultProvider(purpose),
        modelId: row?.modelId ?? this.defaultModel(purpose),
        encryptedApiKey: encrypted.encrypted,
        apiKeyNonce: encrypted.nonce,
        apiKeyAuthTag: encrypted.authTag,
        apiKeyHint: hint(apiKey),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [models.guildId, models.purpose],
        set: {
          encryptedApiKey: encrypted.encrypted,
          apiKeyNonce: encrypted.nonce,
          apiKeyAuthTag: encrypted.authTag,
          apiKeyHint: hint(apiKey),
          updatedAt: now,
        },
      });
  }

  async clearApiKey(guildId: string, purpose: ModelPurpose) {
    await this.db
      .update(models)
      .set({
        encryptedApiKey: null,
        apiKeyNonce: null,
        apiKeyAuthTag: null,
        apiKeyHint: null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(models.guildId, guildId), eq(models.purpose, purpose)));
  }

  async list(guildId: string) {
    return this.db.select().from(models).where(eq(models.guildId, guildId));
  }

  providerConfig(provider: string, modelId: string | null): ModelConfig {
    return {
      provider,
      modelId,
      apiKey: this.defaultApiKey(provider),
      apiKeyHint: null,
    };
  }

  private defaultProvider(purpose: ModelPurpose) {
    return this.defaults[purpose].provider;
  }

  private defaultModel(purpose: ModelPurpose) {
    return this.defaults[purpose].modelId;
  }

  private defaultApiKey(provider: string) {
    return this.defaults.apiKeys?.[provider] ?? null;
  }

  private encryptionKey() {
    return encryptionKey(this.defaults.encryptionKeyBase64);
  }
}

function encryptKey(apiKey: string, key: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(apiKey, 'utf8'),
    cipher.final(),
  ]);
  return {
    encrypted: encrypted.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptKey(
  encrypted: string,
  nonce: string | null,
  authTag: string | null,
  key: Buffer,
) {
  if (!nonce || !authTag) return null;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(nonce, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptionKey(value: string | null | undefined) {
  if (!value)
    throw new Error('API_KEY_ENCRYPTION_KEY is required for BYOK storage');
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32)
    throw new Error('API_KEY_ENCRYPTION_KEY must be base64 encoded 32 bytes');
  return key;
}

function hint(apiKey: string | null) {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 4)}${'*'.repeat(Math.max(4, apiKey.length - 8))}${apiKey.slice(-4)}`;
}
