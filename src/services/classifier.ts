import { loadClassifierPrompt } from './prompts.js';
import type { CachedMessage, ClassificationResult } from '../types.js';
import type {
  ClassifierEvidenceContext,
  ProximalKnownScam,
} from '../domain/types.js';
import type { ModelStore } from './modelStore.js';
import type { FairQueue } from '../queues/fairQueue.js';
import { logVerboseJson } from './verbose.js';

export type AdditionalSignalResult = ClassificationResult & { modelId: string };

export interface ScamClassifier {
  classify(
    message: CachedMessage,
    context: ClassifierEvidenceContext,
  ): Promise<ClassificationResult>;
  additionalSignals?(
    message: CachedMessage,
    context: ClassifierEvidenceContext,
  ): Promise<AdditionalSignalResult[]>;
}

const MODEL_REQUEST_TIMEOUT_MS = 30_000;

type AdditionalSignalModelSet = {
  provider: string;
  models: readonly string[];
};

type AdditionalSignalModels = {
  text: AdditionalSignalModelSet;
  image: AdditionalSignalModelSet;
};

export class OpenRouterScamClassifier implements ScamClassifier {
  constructor(
    private readonly modelStore: ModelStore,
    private readonly queue: FairQueue,
    private readonly additionalSignalModels: AdditionalSignalModels = {
      text: { provider: 'openrouter', models: [] },
      image: { provider: 'openrouter', models: [] },
    },
  ) {}

  async classify(
    message: CachedMessage,
    context: ClassifierEvidenceContext,
  ): Promise<ClassificationResult> {
    return this.queue.enqueue(message.guildId, async () => {
      const hasImages = message.attachments.some((attachment) =>
        attachment.contentType?.startsWith('image/'),
      );
      const purpose = hasImages ? 'image_classifier' : 'text_classifier';
      const systemPrompt = await loadClassifierPrompt(
        hasImages ? 'scam-image' : 'scam-text',
      );
      const config = await this.modelStore.get(message.guildId, purpose);
      const content = contentFor(message, context, hasImages);

      return openRouterJsonClassification(config, systemPrompt, content);
    });
  }

  async additionalSignals(
    message: CachedMessage,
    context: ClassifierEvidenceContext,
  ): Promise<AdditionalSignalResult[]> {
    const hasImages = message.attachments.some((attachment) =>
      attachment.contentType?.startsWith('image/'),
    );
    const signalConfig = hasImages
      ? this.additionalSignalModels.image
      : this.additionalSignalModels.text;
    if (signalConfig.models.length === 0) return [];
    return this.queue.enqueue(message.guildId, async () => {
      const systemPrompt = await loadClassifierPrompt(
        hasImages ? 'scam-image' : 'scam-text',
      );
      const content = contentFor(message, context, hasImages);
      return Promise.all(
        signalConfig.models.map(async (modelId) => {
          const result = await openRouterJsonClassification(
            this.modelStore.providerConfig(signalConfig.provider, modelId),
            systemPrompt,
            content,
          ).catch((error: unknown) => ({
            verdict: 'needs_review' as const,
            confidence: 0,
            rationale: `Additional signal unavailable: ${error instanceof Error ? error.message : String(error)}`,
            labels: [],
          }));
          return { ...result, modelId };
        }),
      );
    });
  }
}

async function openRouterJsonClassification(
  config: { provider: string; modelId: string | null; apiKey: string | null },
  systemPrompt: string,
  content: unknown[],
): Promise<ClassificationResult> {
  if (config.provider !== 'openrouter' || !config.apiKey || !config.modelId) {
    return {
      verdict: 'needs_review',
      confidence: 0,
      rationale: 'Classifier provider/model/key is not configured.',
      labels: [],
    };
  }

  const requestBody = {
    model: config.modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  };
  logVerboseJson('openrouter.classifier.request', requestBody);

  const response = await fetchWithTimeout(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/mia-cx/honeybot',
        'X-Title': 'Honeybot',
      },
      body: JSON.stringify(requestBody),
    },
    MODEL_REQUEST_TIMEOUT_MS,
  );

  const responseText = await response.text();
  const responseJson = parseJsonForLogging(responseText);
  logVerboseJson('openrouter.classifier.response', {
    status: response.status,
    ok: response.ok,
    body: responseJson ?? responseText,
  });

  if (!response.ok) {
    return {
      verdict: 'needs_review',
      confidence: 0,
      rationale: openRouterFailureReason(response, responseText),
      labels: [],
    };
  }
  const json = parseOpenRouterResponse(responseText);
  const raw = json.choices[0]?.message.content;
  if (!raw) throw new Error('OpenRouter classifier returned no content');

  const parsed = parseClassifierResult(raw);
  return {
    verdict:
      parsed.likelihood === 'scam'
        ? 'scam'
        : parsed.likelihood === 'not_scam'
          ? 'not_scam'
          : 'needs_review',
    confidence: parsed.confidence,
    rationale: parsed.reason,
    labels: [],
  };
}

function parseClassifierResult(raw: string) {
  const parsed = parseJsonObject(raw);
  const likelihood = likelihoodFrom(parsed);
  return {
    likelihood,
    confidence: confidenceFrom(parsed, likelihood),
    reason: reasonFrom(parsed, likelihood),
  };
}

function parseOpenRouterResponse(raw: string): OpenRouterResponse {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenRouter classifier returned non-object response JSON');
  }
  return parsed as OpenRouterResponse;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenRouter classifier returned non-object JSON');
  }
  return parsed as Record<string, unknown>;
}

function likelihoodFrom(parsed: Record<string, unknown>) {
  const numericLikelihood = numberField(parsed, [
    'scam_likelihood',
    'scamLikelihood',
    'likelihood_of_scam',
    'likelihoodOfScam',
    'probability_of_scam',
    'probabilityOfScam',
  ]);
  if (numericLikelihood !== null) {
    const normalized = normalizeScore(numericLikelihood);
    if (normalized >= 0.7) return 'scam';
    if (normalized <= 0.3) return 'not_scam';
    return 'needs_review';
  }

  const value = stringField(parsed, [
    'likelihood',
    'verdict',
    'classification',
    'label',
  ])
    .toLowerCase()
    .replace(/[^a-z_]/g, '_');
  if (value.includes('not_scam') || value.includes('benign')) return 'not_scam';
  if (value.includes('needs_review') || value.includes('review'))
    return 'needs_review';
  if (value.includes('scam') || value.includes('phishing')) return 'scam';

  const numericVerdict = numberField(parsed, ['likelihood']);
  if (numericVerdict !== null) {
    const normalized = normalizeScore(numericVerdict);
    if (normalized >= 0.7) return 'scam';
    if (normalized <= 0.3) return 'not_scam';
  }
  return 'needs_review';
}

function confidenceFrom(parsed: Record<string, unknown>, likelihood: string) {
  const scamLikelihood = numberField(parsed, [
    'scam_likelihood',
    'scamLikelihood',
    'likelihood_of_scam',
    'likelihoodOfScam',
    'probability_of_scam',
    'probabilityOfScam',
  ]);
  if (scamLikelihood !== null) return normalizeScore(scamLikelihood);

  const numericLikelihood = numberField(parsed, ['likelihood']);
  if (numericLikelihood !== null) return normalizeScore(numericLikelihood);

  const verdictConfidence = numberField(parsed, [
    'confidence',
    'score',
    'certainty',
  ]);
  if (verdictConfidence === null) return categoricalScamLikelihood(likelihood);

  const normalized = normalizeScore(verdictConfidence);
  if (likelihood === 'scam') return normalized;
  if (likelihood === 'not_scam') return 1 - normalized;
  return 0;
}

function categoricalScamLikelihood(likelihood: string) {
  if (likelihood === 'scam') return 1;
  if (likelihood === 'not_scam') return 0;
  return 0.5;
}

function normalizeScore(value: number) {
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

function reasonFrom(parsed: Record<string, unknown>, likelihood: string) {
  const reason =
    stringField(parsed, ['reason', 'rationale', 'explanation', 'reasoning']) ||
    firstUsefulString(parsed);
  return reason
    ? truncate(reason, 500)
    : `Classifier returned ${likelihood} but omitted reasoning.`;
}

function stringField(parsed: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function numberField(parsed: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsedValue = Number(value.trim().replace(/%$/, ''));
      if (Number.isFinite(parsedValue)) return parsedValue;
    }
  }
  return null;
}

function firstUsefulString(parsed: Record<string, unknown>) {
  for (const [key, value] of Object.entries(parsed)) {
    if (/^(likelihood|verdict|classification|label)$/i.test(key)) continue;
    if (typeof value === 'string' && value.trim().length >= 12) {
      return value.trim();
    }
  }
  return '';
}

function openRouterFailureReason(response: Response, body: string) {
  const detail = openRouterErrorDetail(body);
  const retryAfter = response.headers.get('retry-after');
  const rateLimitHint =
    response.status === 429
      ? ' OpenRouter rate-limited the request or the API key/model has no remaining quota.'
      : '';
  const retryHint = retryAfter ? ` Retry after ${retryAfter}s.` : '';
  return `Classifier unavailable: OpenRouter returned HTTP ${response.status}.${rateLimitHint}${retryHint}${detail ? ` ${detail}` : ''}`;
}

function openRouterErrorDetail(body: string) {
  const parsed = parseErrorJson(body);
  const error =
    parsed && typeof parsed.error === 'object' && parsed.error
      ? (parsed.error as Record<string, unknown>)
      : null;
  if (!error) return truncate(body, 300);

  const provider = metadataString(error, 'provider_name');
  const raw = metadataRaw(error);
  const rawMessage = raw ? parseErrorMessage(raw) : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return truncate(
    [message, provider ? `provider=${provider}` : '', rawMessage]
      .filter(Boolean)
      .join(' — '),
    300,
  );
}

function parseJsonForLogging(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseErrorJson(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function metadataString(error: Record<string, unknown>, key: string) {
  const metadata = error.metadata;
  if (!metadata || typeof metadata !== 'object') return '';
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function metadataRaw(error: Record<string, unknown>) {
  const metadata = error.metadata;
  if (!metadata || typeof metadata !== 'object') return '';
  const raw = (metadata as Record<string, unknown>).raw;
  return typeof raw === 'string' ? raw : '';
}

function parseErrorMessage(raw: string) {
  const parsed = parseErrorJson(raw);
  const error =
    parsed && typeof parsed.error === 'object' && parsed.error
      ? (parsed.error as Record<string, unknown>)
      : null;
  const message = error?.message;
  return typeof message === 'string' ? message : raw;
}

function contentFor(
  message: CachedMessage,
  context: ClassifierEvidenceContext,
  includeImages: boolean,
) {
  return [
    { type: 'text', text: promptFor(message, context, includeImages) },
    ...(includeImages
      ? [
          ...message.attachments
            .filter((attachment) =>
              attachment.contentType?.startsWith('image/'),
            )
            .flatMap((attachment, index) => [
              {
                type: 'text',
                text: `Current case image ${index + 1}: ${attachment.name ?? attachment.id}`,
              },
              {
                type: 'image_url',
                image_url: { url: imageUrlFor(attachment) },
              },
            ]),
          ...proximalKnownScamImageParts(context.proximalKnownScams),
        ]
      : []),
  ];
}

function promptFor(
  message: CachedMessage,
  context: ClassifierEvidenceContext,
  includeImages: boolean,
) {
  return JSON.stringify({
    currentCase: includeImages
      ? {
          message: message.content,
          attachments: message.attachments.map((attachment) => ({
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
          })),
        }
      : { message: message.content },
    proximalKnownScams: context.proximalKnownScams.map((scam, scamIndex) => ({
      reference: `known_scam_${scamIndex + 1}`,
      similarity: Number(scam.score.toFixed(3)),
      description: scam.description,
      scamReason: scam.scamReason,
      knownText: scam.normalizedText,
      ...(includeImages
        ? {
            images: scam.images.map((image, imageIndex) => ({
              reference: `known_scam_${scamIndex + 1}_image_${imageIndex + 1}`,
              contentType: image.contentType,
              size: image.sizeBytes,
            })),
          }
        : {}),
    })),
    classifierTask: includeImages
      ? 'Make an independent classifier verdict from the current message/images. Proximal known scams are reference examples only: compare concrete visual/text similarities and differences, but do not restate retrieval, exact-match, or embedding scores as your reason. If differences look like parody, quotation, warning, or other humorous/benign intent rather than credential theft, payment bait, phishing, or spam, lower the scam verdict accordingly and explain that difference.'
      : 'Make an independent classifier verdict from the current text. Proximal known scams are reference examples only: compare concrete textual similarities and differences, but do not restate retrieval, exact-match, or embedding scores as your reason. If differences look like parody, quotation, warning, or other humorous/benign intent rather than credential theft, payment bait, phishing, or spam, lower the scam verdict accordingly and explain that difference.',
  });
}

function imageUrlFor(attachment: CachedMessage['attachments'][number]) {
  return attachment.dataUrl ?? attachment.proxyUrl ?? attachment.url;
}

function proximalKnownScamImageParts(scams: ProximalKnownScam[]) {
  let remainingImages = 10;
  return scams.flatMap((scam, scamIndex) => {
    const images = scam.images.slice(0, remainingImages);
    remainingImages -= images.length;
    return images.flatMap((image, imageIndex) => [
      {
        type: 'text',
        text: `Known scam ${scamIndex + 1} image ${imageIndex + 1}: ${scam.scamReason}`,
      },
      { type: 'image_url', image_url: { url: image.dataUrl } },
    ]);
  });
}

type OpenRouterResponse = {
  choices: Array<{ message: { content: string | null } }>;
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`OpenRouter classifier timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export { loadClassifierPrompt };
