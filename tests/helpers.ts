import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import type { ModelDefaults } from '../src/services/modelStore.js';

const tempDirs: string[] = [];

export function testDatabase(prefix = 'honeybot-test-'): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return openDatabase(`file:${join(dir, 'test.sqlite')}`);
}

export function testDatabaseWithSetup(
  setup: (sqlite: Database.Database) => void,
): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'honeybot-migration-test-'));
  tempDirs.push(dir);
  const path = join(dir, 'test.sqlite');
  const sqlite = new Database(path);
  setup(sqlite);
  sqlite.close();
  return openDatabase(`file:${path}`);
}

export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

export function testModelDefaults(
  overrides: Partial<ModelDefaults> = {},
): ModelDefaults {
  return {
    text_classifier: { provider: 'openrouter', modelId: 'text-model' },
    image_classifier: { provider: 'openrouter', modelId: 'image-model' },
    text_embeddings: { provider: 'openrouter', modelId: 'text-embed' },
    image_embeddings: { provider: 'openrouter', modelId: 'image-embed' },
    apiKeys: { openrouter: 'default-openrouter-key' },
    encryptionKeyBase64: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  };
}
