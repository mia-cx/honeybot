import type { ModelPurpose } from '../domain/types.js';
import type { CachedAttachment } from '../types.js';
import type { FairQueue } from '../queues/fairQueue.js';
import type { ModelConfig, ModelStore } from './modelStore.js';

const MODEL_REQUEST_TIMEOUT_MS = 30_000;
export type EmbeddingResult = {
  provider: string;
  model: string;
  dimensions: number;
  vector: number[];
};

export type ImageEmbeddingInput = Pick<
  CachedAttachment,
  'contentType' | 'name' | 'url'
> & {
  storageKey?: string | null;
  dataUrl?: string | undefined;
};

export interface ScamEmbedder {
  embedText(guildId: string, text: string): Promise<EmbeddingResult | null>;
  embedImage(
    guildId: string,
    image: ImageEmbeddingInput,
  ): Promise<EmbeddingResult | null>;
}

export type OpenRouterEmbeddingOptions = {
  dataCollection?: 'allow' | 'deny';
};

export class OpenRouterEmbeddings implements ScamEmbedder {
  constructor(
    private readonly modelStore: ModelStore,
    private readonly queue: FairQueue,
    private readonly dimensions: number,
    private readonly options: OpenRouterEmbeddingOptions = {},
  ) {}

  async embedText(guildId: string, text: string) {
    const input = text.trim();
    if (!input) return null;
    return this.embed(guildId, 'text_embeddings', input);
  }

  async embedImage(guildId: string, image: ImageEmbeddingInput) {
    const imageUrl = image.dataUrl ?? image.url;
    if (!imageUrl || !image.contentType?.startsWith('image/')) return null;
    return this.embed(guildId, 'image_embeddings', [
      {
        content: [
          {
            type: 'text',
            text: `Discord moderation evidence image${image.name ? `: ${image.name}` : ''}`,
          },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ]);
  }

  private async embed(
    guildId: string,
    purpose: ModelPurpose,
    input: OpenRouterEmbeddingInput,
  ): Promise<EmbeddingResult | null> {
    return this.queue.enqueue(guildId, async () => {
      const config = await this.modelStore.get(guildId, purpose);
      return openRouterEmbedding(config, input, this.dimensions, this.options);
    });
  }
}

type OpenRouterEmbeddingInput =
  | string
  | Array<{
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
    }>;

async function openRouterEmbedding(
  config: ModelConfig,
  input: OpenRouterEmbeddingInput,
  dimensions: number,
  options: OpenRouterEmbeddingOptions,
): Promise<EmbeddingResult | null> {
  if (config.provider !== 'openrouter' || !config.apiKey || !config.modelId) {
    return null;
  }

  const response = await fetchWithTimeout(
    'https://openrouter.ai/api/v1/embeddings',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/mia-cx/honeybot',
        'X-Title': 'Honeybot',
      },
      body: JSON.stringify({
        model: config.modelId,
        input,
        ...embeddingDimensionOverride(config.modelId, dimensions),
        ...(options.dataCollection
          ? { provider: { data_collection: options.dataCollection } }
          : {}),
      }),
    },
    MODEL_REQUEST_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(await openRouterEmbeddingFailureReason(response));
  }

  const json = (await response.json()) as OpenRouterEmbeddingResponse;
  const vector = json.data[0]?.embedding;
  if (
    !Array.isArray(vector) ||
    !vector.every((value) => Number.isFinite(value))
  ) {
    throw new Error('OpenRouter embeddings returned no numeric vector');
  }
  return {
    provider: config.provider,
    model: config.modelId,
    dimensions: vector.length,
    vector,
  };
}

type OpenRouterEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

function embeddingDimensionOverride(modelId: string, dimensions: number) {
  return modelSupportsDimensionOverride(modelId) ? { dimensions } : {};
}

function modelSupportsDimensionOverride(modelId: string) {
  const normalized = modelId.toLowerCase().replace(/:free$/, '');
  if (normalized === 'nvidia/llama-nemotron-embed-vl-1b-v2') return false;
  return true;
}

async function openRouterEmbeddingFailureReason(response: Response) {
  const detail = truncate(await response.text().catch(() => ''), 300);
  const retryAfter = response.headers.get('retry-after');
  const rateLimitHint =
    response.status === 429
      ? ' OpenRouter rate-limited the embedding request or the API key/model has no remaining quota.'
      : '';
  const retryHint = retryAfter ? ` Retry after ${retryAfter}s.` : '';
  return `OpenRouter returned HTTP ${response.status}.${rateLimitHint}${retryHint}${detail ? ` ${detail}` : ''}`;
}

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
      throw new Error(`OpenRouter embeddings timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
