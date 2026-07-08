import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Schema } from 'effect';
import { and, eq, or } from 'drizzle-orm';
import { openDatabase } from '../src/db/database.js';
import { knownImages, knownTexts } from '../src/db/schema.js';
import { env } from '../src/env.js';
import { FairQueue } from '../src/queues/fairQueue.js';
import {
  OpenRouterEmbeddings,
  type EmbeddingResult,
  type ImageEmbeddingInput,
} from '../src/services/embeddings.js';
import { ModelStore } from '../src/services/modelStore.js';
import { FileStorage } from '../src/storage/fileStorage.js';
import { normalizeAttachmentFile } from '../src/storage/imageNormalization.js';
import { normalizeText, sha256, textHash } from '../src/utils/fingerprints.js';

const fixtureSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    expected: Schema.Literals(['scam', 'not_scam', 'needs_review']),
    message: Schema.String,
  }),
);

const seedActor = 'fixture-seed';
const fixtureGuildId = 'fixture-seed';
const textFixturesPath =
  process.argv[2] ?? 'tests/fixtures/classifier/text-cases.json';
const imageFixtureDirs = ['tests/fixtures/images', env.EVAL_CORPUS_DIR].filter(
  (dir): dir is string => Boolean(dir),
);

const database = openDatabase(env.DATABASE_URL);
const storage = new FileStorage(env.IMAGE_STORAGE_DIR);
const modelStore = new ModelStore(database.db, {
  text_classifier: {
    provider: env.DEFAULT_TEXT_PRIMARY_PROVIDER,
    modelId: env.DEFAULT_TEXT_PRIMARY_MODEL,
  },
  image_classifier: {
    provider: env.DEFAULT_IMAGE_PRIMARY_PROVIDER,
    modelId: env.DEFAULT_IMAGE_PRIMARY_MODEL,
  },
  text_embeddings: {
    provider: env.DEFAULT_TEXT_EMBEDDINGS_PROVIDER,
    modelId: env.DEFAULT_TEXT_EMBEDDINGS_MODEL,
  },
  image_embeddings: {
    provider: env.DEFAULT_IMAGE_EMBEDDINGS_PROVIDER,
    modelId: env.DEFAULT_IMAGE_EMBEDDINGS_MODEL,
  },
  apiKeys: { openrouter: env.OPENROUTER_API_KEY ?? null },
  encryptionKeyBase64: env.API_KEY_ENCRYPTION_KEY ?? null,
});
const queue = new FairQueue({
  name: 'fixture-seed-embeddings',
  globalLimit: env.MODEL_CALL_LIMIT,
  perGuildLimit: env.MODEL_CALL_LIMIT_PER_GUILD,
  windowMs: env.MODEL_CALL_WINDOW_SECONDS * 1000,
  logFailures: false,
});
const embedder = new OpenRouterEmbeddings(
  modelStore,
  queue,
  env.DEFAULT_EMBEDDINGS_DIMENSIONS,
);

const result = {
  textAdded: 0,
  textUpdated: 0,
  textSkipped: 0,
  imageAdded: 0,
  imageUpdated: 0,
  imageSkipped: 0,
  embeddingFailed: 0,
};
const embeddingFailures: string[] = [];
try {
  await seedTextFixtures();
  await seedImageFixtures();
  console.log(
    `Seeded fixture corpus: ${result.textAdded} text added, ${result.textUpdated} text updated, ${result.textSkipped} text skipped, ${result.imageAdded} images added, ${result.imageUpdated} images updated, ${result.imageSkipped} images skipped, ${result.embeddingFailed} embedding failures.`,
  );
  if (result.embeddingFailed > 0) {
    console.error(
      'Fixture corpus seeding failed: every approved corpus item must have embeddings from the configured production embedding model.',
    );
    console.error(
      'Fix the OpenRouter account privacy/model routing for DEFAULT_TEXT_EMBEDDINGS_MODEL and DEFAULT_IMAGE_EMBEDDINGS_MODEL, or set those env vars to production-allowed embedding models, then rerun pnpm seed:fixtures.',
    );
    for (const failure of embeddingFailures.slice(0, 5)) {
      console.error(`- ${failure}`);
    }
    if (embeddingFailures.length > 5) {
      console.error(
        `- …and ${embeddingFailures.length - 5} more embedding failures.`,
      );
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  database.sqlite.close();
}

async function seedTextFixtures() {
  const fixtures = Schema.decodeUnknownSync(fixtureSchema)(
    JSON.parse(await readFile(resolve(textFixturesPath), 'utf8')),
  );
  for (const fixture of fixtures) {
    if (fixture.expected !== 'scam') {
      result.textSkipped += 1;
      continue;
    }
    const normalizedText = normalizeText(fixture.message);
    if (!normalizedText) {
      result.textSkipped += 1;
      continue;
    }
    const hash = textHash(fixture.message);
    if (!hash) {
      result.textSkipped += 1;
      continue;
    }
    const existing = await database.db
      .select()
      .from(knownTexts)
      .where(and(eq(knownTexts.textHash, hash), eq(knownTexts.scope, 'global')))
      .get();
    if (existing && hasExpectedEmbedding(existing, 'text')) {
      result.textSkipped += 1;
      continue;
    }
    const embedding = await textEmbeddingFor(fixture.id, normalizedText);
    if (!embedding) {
      if (existing) await markKnownTextInvalid(existing.id);
      result.textSkipped += 1;
      result.embeddingFailed += 1;
      continue;
    }
    const now = new Date().toISOString();
    if (existing) {
      await database.db
        .update(knownTexts)
        .set({
          embeddingProvider: embedding.provider,
          embeddingModel: embedding.model,
          embeddingDimensions: embedding.dimensions,
          embeddingVectorJson: JSON.stringify(embedding.vector),
          status: 'approved',
          updatedAt: now,
        })
        .where(eq(knownTexts.id, existing.id));
      result.textUpdated += 1;
      continue;
    }

    await database.db.insert(knownTexts).values({
      id: `fixture:${fixture.id}`,
      normalizedText,
      textHash: hash,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      embeddingDimensions: embedding.dimensions,
      embeddingVectorJson: JSON.stringify(embedding.vector),
      description: `Fixture scam text: ${fixture.id}`,
      scamReason: 'Seeded scam fixture for known-corpus retrieval.',
      sourceCaseId: null,
      sourceDiscordMessageId: null,
      approvedBy: seedActor,
      scope: 'global',
      guildId: null,
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    });
    result.textAdded += 1;
  }
}

async function seedImageFixtures() {
  const paths = await fixtureImagePaths(imageFixtureDirs);
  for (const path of paths) {
    const sourceBytes = await readFile(path);
    const contentType = contentTypeFor(path);
    const name = basename(path);
    const normalized = await normalizeAttachmentFile(
      sourceBytes,
      contentType,
      name,
    );
    const bytes = normalized.buffer;
    const storedContentType = normalized.contentType ?? contentType;
    const storedName = normalized.fileName;
    const digest = sha256(bytes);
    const fixtureId = `fixture:${name.replace(/\.[^.]+$/, '')}`;
    const existing = await database.db
      .select()
      .from(knownImages)
      .where(
        and(
          or(eq(knownImages.sha256, digest), eq(knownImages.id, fixtureId)),
          eq(knownImages.scope, 'global'),
        ),
      )
      .get();
    const storageKey = `fixtures/${digest}-${safeBasename(storedName)}`;
    const dataUrl = `data:${storedContentType};base64,${bytes.toString('base64')}`;
    if (
      existing &&
      existing.sha256 === digest &&
      existing.storageKey === storageKey &&
      hasExpectedEmbedding(existing, 'image')
    ) {
      result.imageSkipped += 1;
      continue;
    }
    const embedding = await imageEmbeddingFor(name, {
      contentType: storedContentType,
      name: storedName,
      url: dataUrl,
      storageKey,
      dataUrl,
    });
    if (!embedding) {
      if (existing) await markKnownImageInvalid(existing.id);
      result.imageSkipped += 1;
      result.embeddingFailed += 1;
      continue;
    }
    const now = new Date().toISOString();
    await mkdir(join(env.IMAGE_STORAGE_DIR, 'fixtures'), { recursive: true });
    await writeFile(storage.pathFor(storageKey), bytes);
    if (existing) {
      await database.db
        .update(knownImages)
        .set({
          sha256: digest,
          storageKey,
          embeddingProvider: embedding.provider,
          embeddingModel: embedding.model,
          embeddingDimensions: embedding.dimensions,
          embeddingVectorJson: JSON.stringify(embedding.vector),
          status: 'approved',
          updatedAt: now,
        })
        .where(eq(knownImages.id, existing.id));
      result.imageUpdated += 1;
      continue;
    }

    await database.db.insert(knownImages).values({
      id: fixtureId,
      sha256: digest,
      perceptualHash: null,
      storageKey,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      embeddingDimensions: embedding.dimensions,
      embeddingVectorJson: JSON.stringify(embedding.vector),
      description: `Fixture scam image: ${name}`,
      scamReason: 'Seeded mrscam fixture image for known-corpus retrieval.',
      sourceCaseId: null,
      sourceDiscordAttachmentId: null,
      approvedBy: seedActor,
      scope: 'global',
      guildId: null,
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    });
    result.imageAdded += 1;
  }
}

async function textEmbeddingFor(label: string, text: string) {
  return requiredEmbedding(`Text fixture ${label}`, () =>
    embedder.embedText(fixtureGuildId, text),
  );
}

async function imageEmbeddingFor(label: string, image: ImageEmbeddingInput) {
  return requiredEmbedding(`Image fixture ${label}`, () =>
    embedder.embedImage(fixtureGuildId, image),
  );
}

async function requiredEmbedding(
  label: string,
  operation: () => Promise<EmbeddingResult | null>,
) {
  const embedding = await operation().catch((error: unknown) => {
    embeddingFailures.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
  if (!embedding) {
    if (!embeddingFailures.some((failure) => failure.startsWith(`${label}:`))) {
      embeddingFailures.push(
        `${label}: embedding provider returned no vector.`,
      );
    }
    return null;
  }
  return embedding;
}

async function markKnownTextInvalid(id: string) {
  await database.db
    .update(knownTexts)
    .set({
      embeddingProvider: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embeddingVectorJson: null,
      status: 'invalid_missing_embedding',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(knownTexts.id, id));
}

async function markKnownImageInvalid(id: string) {
  await database.db
    .update(knownImages)
    .set({
      embeddingProvider: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embeddingVectorJson: null,
      status: 'invalid_missing_embedding',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(knownImages.id, id));
}

function hasExpectedEmbedding(
  row: {
    embeddingProvider: string | null;
    embeddingModel: string | null;
    embeddingDimensions: number | null;
    embeddingVectorJson: string | null;
  },
  kind: 'text' | 'image',
) {
  const expectedProvider =
    kind === 'text'
      ? env.DEFAULT_TEXT_EMBEDDINGS_PROVIDER
      : env.DEFAULT_IMAGE_EMBEDDINGS_PROVIDER;
  const expectedModel =
    kind === 'text'
      ? env.DEFAULT_TEXT_EMBEDDINGS_MODEL
      : env.DEFAULT_IMAGE_EMBEDDINGS_MODEL;
  return Boolean(
    row.embeddingProvider === expectedProvider &&
    row.embeddingModel === expectedModel &&
    row.embeddingDimensions &&
    row.embeddingVectorJson,
  );
}

async function fixtureImagePaths(dirs: string[]) {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const resolved = resolve(dir);
    const entries = await readdir(resolved).catch(() => []);
    for (const name of entries.sort(naturalCompare)) {
      if (!/^mrscam/i.test(name)) continue;
      const path = join(resolved, name);
      if (seen.has(path)) continue;
      if (!contentTypeFor(path).startsWith('image/')) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function contentTypeFor(path: string) {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function safeBasename(name: string) {
  return (
    basename(name)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 80) || 'attachment.bin'
  );
}
