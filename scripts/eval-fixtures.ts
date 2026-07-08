import 'dotenv/config';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Schema } from 'effect';

const verdictSchema = Schema.Literals(['scam', 'not_scam', 'needs_review']);
const confidenceSchema = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const fixtureSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    prompt: Schema.Literals(['text', 'image']),
    expected: verdictSchema,
    minConfidence: confidenceSchema,
    message: Schema.String,
    attachments: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        contentType: Schema.String,
      }),
    ),
    evidenceSummary: Schema.String,
  }),
);

const classifierResultSchema = Schema.Struct({
  likelihood: verdictSchema,
  confidence: confidenceSchema,
  reason: Schema.String,
});

type Fixture = Schema.Schema.Type<typeof fixtureSchema>[number];

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey || apiKey === 'replace-me') {
  throw new Error('OPENROUTER_API_KEY is required to run fixture evals. Fill .env first.');
}

const textModel = process.env.DEFAULT_TEXT_CLASSIFIER_MODEL || 'google/gemma-4-26b-a4b-it:free';
const imageModel = process.env.DEFAULT_IMAGE_CLASSIFIER_MODEL || textModel;
const textFixturesPath = process.argv[2] ?? 'tests/fixtures/classifier/text-cases.json';
const corpusDirs = ['tests/fixtures/images', process.env.EVAL_CORPUS_DIR].filter((dir): dir is string => Boolean(dir));
const fixtures = [
  ...Schema.decodeUnknownSync(fixtureSchema)(JSON.parse(await readFile(textFixturesPath, 'utf8'))),
  ...(await discoverMrScamFixtures(corpusDirs)),
];
const prompts = {
  text: await readFile('prompts/scam-text.md', 'utf8'),
  image: await readFile('prompts/scam-image.md', 'utf8'),
};

let failures = 0;

for (const fixture of fixtures) {
  const result = await classifyFixture(fixture);
  const passed = result.likelihood === fixture.expected && result.confidence >= fixture.minConfidence;
  if (!passed) failures += 1;

  console.log(
    [
      passed ? 'PASS' : 'FAIL',
      fixture.id,
      `expected=${fixture.expected}@>=${fixture.minConfidence}`,
      `got=${result.likelihood}@${result.confidence.toFixed(2)}`,
      result.reason,
    ].join(' | '),
  );
}

if (failures > 0) {
  console.error(`${failures}/${fixtures.length} fixture eval(s) failed.`);
  process.exit(1);
}

console.log(`${fixtures.length} fixture eval(s) passed.`);

async function classifyFixture(fixture: Fixture) {
  const content: Array<unknown> = [
    {
      type: 'text',
      text: JSON.stringify({
        message: fixture.message,
        attachments: fixture.attachments.map((attachment) => ({
          name: attachment.path.split('/').at(-1),
          contentType: attachment.contentType,
        })),
        evidenceSummary: fixture.evidenceSummary,
      }),
    },
  ];

  for (const attachment of fixture.attachments) {
    content.push({
      type: 'image_url',
      image_url: {
        url: await dataUrl(attachment.path, attachment.contentType),
      },
    });
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/mia-cx/honeybot',
      'X-Title': 'Honeybot Fixture Eval',
    },
    body: JSON.stringify({
      model: fixture.prompt === 'image' ? imageModel : textModel,
      messages: [
        { role: 'system', content: prompts[fixture.prompt] },
        { role: 'user', content },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed for ${fixture.id}: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`OpenRouter returned no content for ${fixture.id}`);

  return Schema.decodeUnknownSync(classifierResultSchema)(JSON.parse(stripCodeFence(raw)));
}

async function discoverMrScamFixtures(dirs: string[]): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    const resolved = resolve(dir);
    const entries = await readdir(resolved).catch(() => []);

    for (const name of entries.sort(naturalCompare)) {
      if (!/^mrscam/i.test(name)) continue;
      const path = join(resolved, name);
      if (seen.has(path)) continue;
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      const contentType = contentTypeFor(path);
      if (!contentType.startsWith('image/')) continue;
      seen.add(path);

      fixtures.push({
        id: name.replace(/\.[^.]+$/, ''),
        prompt: 'image',
        expected: 'scam',
        minConfidence: 0.75,
        message: 'Image-only Discord raid/scam candidate from mrscam fixture corpus.',
        attachments: [{ path, contentType }],
        evidenceSummary: 'mrscam evaluation corpus. Treat as suspected scam image; classify from image content, not from this label alone.',
      });
    }
  }

  if (fixtures.length === 0) {
    console.warn('No mrscam* image fixtures found in tests/fixtures/images or EVAL_CORPUS_DIR.');
  }

  return fixtures;
}

async function dataUrl(path: string, contentType: string) {
  const bytes = await readFile(resolve(path));
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

function contentTypeFor(path: string) {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

function stripCodeFence(value: string) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
