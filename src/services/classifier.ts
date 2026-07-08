import { Schema } from 'effect';
import { loadClassifierPrompt } from './prompts.js';
import type { CachedMessage, ClassificationResult } from '../types.js';
import type { ModelStore } from './modelStore.js';
import type { FairQueue } from '../queues/fairQueue.js';

export interface ScamClassifier {
  classify(message: CachedMessage, evidenceSummary: string): Promise<ClassificationResult>;
}

const classifierResultSchema = Schema.Struct({
  likelihood: Schema.optionalKey(Schema.Literals(['scam', 'not_scam', 'needs_review'])),
  confidence: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  reason: Schema.optionalKey(Schema.String.check(Schema.isLengthBetween(1, 500))),
});

export class OpenRouterScamClassifier implements ScamClassifier {
  constructor(
    private readonly modelStore: ModelStore,
    private readonly queue: FairQueue,
  ) {}

  async classify(message: CachedMessage, evidenceSummary: string): Promise<ClassificationResult> {
    return this.queue.enqueue(message.guildId, async () => {
      const hasImages = message.attachments.some((attachment) => attachment.contentType?.startsWith('image/'));
      const purpose = hasImages ? 'image_classifier' : 'text_classifier';
      const systemPrompt = await loadClassifierPrompt(hasImages ? 'scam-image' : 'scam-text');
      const config = await this.modelStore.get(message.guildId, purpose);
      if (config.provider !== 'openrouter' || !config.apiKey || !config.modelId) {
        return {
          verdict: 'needs_review',
          confidence: 0,
          rationale: 'Classifier provider/model/key is not configured.',
          labels: [],
        };
      }

      const content = [
        { type: 'text', text: promptFor(message, evidenceSummary) },
        ...message.attachments
          .filter((attachment) => attachment.contentType?.startsWith('image/'))
          .slice(0, 4)
          .map((attachment) => ({ type: 'image_url', image_url: { url: attachment.url } })),
      ];

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/mia-cx/honeybot',
          'X-Title': 'Honeybot',
        },
        body: JSON.stringify({
          model: config.modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
        }),
      });

      if (!response.ok) {
        return {
          verdict: 'needs_review',
          confidence: 0,
          rationale: await openRouterFailureReason(response),
          labels: [],
        };
      }
      const json = (await response.json()) as OpenRouterResponse;
      const raw = json.choices[0]?.message.content;
      if (!raw) throw new Error('OpenRouter classifier returned no content');

      const parsed = parseClassifierResult(raw);
      return {
        verdict: parsed.likelihood === 'scam' ? 'scam' : parsed.likelihood === 'not_scam' ? 'not_scam' : 'needs_review',
        confidence: parsed.confidence,
        rationale: parsed.reason,
        labels: [],
      };
    });
  }
}

function parseClassifierResult(raw: string) {
  const parsed = Schema.decodeUnknownSync(classifierResultSchema)(JSON.parse(raw));
  return {
    likelihood: parsed.likelihood ?? 'needs_review',
    confidence: parsed.confidence ?? 0,
    reason: parsed.reason ?? 'No reason returned.',
  };
}

async function openRouterFailureReason(response: Response) {
  const detail = truncate(await response.text().catch(() => ''), 300);
  const retryAfter = response.headers.get('retry-after');
  const rateLimitHint = response.status === 429 ? ' OpenRouter rate-limited the request or the API key/model has no remaining quota.' : '';
  const retryHint = retryAfter ? ` Retry after ${retryAfter}s.` : '';
  return `Classifier unavailable: OpenRouter returned HTTP ${response.status}.${rateLimitHint}${retryHint}${detail ? ` ${detail}` : ''}`;
}

function promptFor(message: CachedMessage, evidenceSummary: string) {
  return JSON.stringify({
    message: message.content,
    attachments: message.attachments.map((attachment) => ({ name: attachment.name, contentType: attachment.contentType, size: attachment.size })),
    evidenceSummary,
  });
}

type OpenRouterResponse = {
  choices: Array<{ message: { content: string | null } }>;
};

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export { loadClassifierPrompt };
