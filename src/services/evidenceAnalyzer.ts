import type { CaseStore } from './caseStore.js';
import type { ScamClassifier } from './classifier.js';
import type { EmbeddingResult, ScamEmbedder } from './embeddings.js';
import type {
  AnalysisResult,
  ClassifierEvidenceContext,
  EvidenceItem,
  GuildConfig,
} from '../domain/types.js';
import type { CachedMessage } from '../types.js';

export type AnalysisProgress = {
  phase: 'matches' | 'embeddings' | 'classifier';
  result: AnalysisResult;
};

export class EvidenceAnalyzer {
  private readonly cache = new Map<string, AnalysisResult>();

  constructor(
    private readonly caseStore: CaseStore,
    private readonly classifier: ScamClassifier,
    private readonly embedder?: ScamEmbedder,
  ) {}

  async analyze(
    caseId: string,
    cached: CachedMessage,
    config: GuildConfig,
    onProgress?: (progress: AnalysisProgress) => Promise<void>,
  ): Promise<AnalysisResult> {
    const cacheKey = fingerprintKey(cached);
    const cachedResult = this.cache.get(cacheKey);
    if (cachedResult) return cachedResult;

    const evidence: EvidenceItem[] = [];
    const embeddingsPromise = this.embeddingsFor(cached);

    if (cached.textHash) {
      const knownText = await this.caseStore.findKnownTextByHash(
        cached.guildId,
        cached.textHash,
      );
      if (knownText) {
        evidence.push({
          type: 'exact_match',
          matched: true,
          score: 1,
          summary: `Exact known text match: ${knownText.scamReason}`,
          metadata: { knownTextId: knownText.id },
        });
      }
    }

    for (const attachment of cached.attachments) {
      if (!attachment.sha256) continue;
      const knownImage = await this.caseStore.findKnownImageBySha(
        cached.guildId,
        attachment.sha256,
      );
      if (knownImage) {
        evidence.push({
          type: 'exact_match',
          matched: true,
          score: 1,
          summary: `Exact known image match: ${knownImage.scamReason}`,
          metadata: { knownImageId: knownImage.id },
        });
      }
    }

    const fuzzyKnownScams = await this.caseStore.findProximalKnownScams(cached);
    const fuzzyEvidence = fuzzyEvidenceFrom(fuzzyKnownScams, config);
    if (fuzzyEvidence) evidence.push(fuzzyEvidence);
    await onProgress?.({
      phase: 'matches',
      result: analysisFromEvidence(evidence, config),
    });

    const { textEmbedding, imageEmbeddings, diagnostics } =
      await embeddingsPromise;
    const proximalKnownScams = await this.caseStore.findProximalKnownScams(
      cached,
      { textEmbedding, imageEmbeddings },
    );
    evidence.push(
      embeddingEvidenceFrom(proximalKnownScams, diagnostics, config),
    );
    await onProgress?.({
      phase: 'embeddings',
      result: analysisFromEvidence(evidence, config),
    });
    const classifierContext: ClassifierEvidenceContext = {
      evidenceSummary: summarizeEvidence(evidence),
      proximalKnownScams,
    };
    const classifierResult = await this.classifier
      .classify(cached, classifierContext)
      .catch((error: unknown) => ({
        verdict: 'needs_review' as const,
        confidence: 0,
        rationale: `Classifier unavailable: ${error instanceof Error ? error.message : String(error)}`,
        labels: [],
      }));
    evidence.push({
      type: 'classifier',
      matched: classifierResult.verdict === 'scam',
      score:
        classifierResult.verdict === 'scam' ? classifierResult.confidence : 0,
      summary: classifierResult.rationale,
      metadata: {
        verdict: classifierResult.verdict,
        source: 'primary_classifier',
      },
    });
    await onProgress?.({
      phase: 'classifier',
      result: analysisFromEvidence(evidence, config),
    });

    const additionalSignals = await this.classifier
      .additionalSignals?.(cached, classifierContext)
      .catch((error: unknown) => [
        {
          verdict: 'needs_review' as const,
          confidence: 0,
          rationale: `Additional signal unavailable: ${error instanceof Error ? error.message : String(error)}`,
          labels: [],
          modelId: 'unknown',
        },
      ]);
    for (const signal of additionalSignals ?? []) {
      evidence.push({
        type: 'classifier',
        matched: signal.verdict === 'scam',
        score: signal.verdict === 'scam' ? signal.confidence : 0,
        summary: signal.rationale,
        metadata: {
          verdict: signal.verdict,
          source: 'additional_signal',
          modelId: signal.modelId,
          advisoryOnly: true,
        },
      });
      await onProgress?.({
        phase: 'classifier',
        result: analysisFromEvidence(evidence, config),
      });
    }

    const result = analysisFromEvidence(evidence, config);
    await this.caseStore.saveAnalysis(caseId, result);
    this.cache.set(cacheKey, result);
    return result;
  }

  private async embeddingsFor(cached: CachedMessage): Promise<{
    textEmbedding: EmbeddingResult | null;
    imageEmbeddings: EmbeddingResult[];
    diagnostics: EmbeddingDiagnostics;
  }> {
    const diagnostics: EmbeddingDiagnostics = {
      providerConfigured: this.embedder !== undefined,
      textAttempted: cached.normalizedContent.length > 0,
      textSucceeded: false,
      imageAttempted: cached.attachments.some((attachment) =>
        attachment.contentType?.startsWith('image/'),
      ),
      imageSucceeded: 0,
    };
    if (!this.embedder)
      return { textEmbedding: null, imageEmbeddings: [], diagnostics };
    const textEmbedding = diagnostics.textAttempted
      ? await this.embedder
          .embedText(cached.guildId, cached.normalizedContent)
          .catch(() => null)
      : null;
    diagnostics.textSucceeded = textEmbedding !== null;
    const imageEmbeddings = await Promise.all(
      cached.attachments
        .filter((attachment) => attachment.contentType?.startsWith('image/'))
        .map((attachment) =>
          this.embedder!.embedImage(cached.guildId, attachment).catch(
            () => null,
          ),
        ),
    );
    const successfulImageEmbeddings = imageEmbeddings.filter(isEmbeddingResult);
    diagnostics.imageSucceeded = successfulImageEmbeddings.length;
    return {
      textEmbedding,
      imageEmbeddings: successfulImageEmbeddings,
      diagnostics,
    };
  }
}

type EmbeddingDiagnostics = {
  providerConfigured: boolean;
  textAttempted: boolean;
  textSucceeded: boolean;
  imageAttempted: boolean;
  imageSucceeded: number;
};

function fuzzyEvidenceFrom(
  proximalKnownScams: ClassifierEvidenceContext['proximalKnownScams'],
  config: GuildConfig,
): EvidenceItem | null {
  const top = proximalKnownScams.find((scam) => scam.source === 'text_fuzzy');
  if (!top) return null;
  return {
    type: 'fuzzy_match',
    matched: top.score >= config.knownTextSimilarityThreshold,
    score: top.score,
    summary: `Fuzzy text similarity to known scam: ${top.scamReason}`,
    metadata: {
      knownScamId: top.id,
      threshold: config.knownTextSimilarityThreshold,
    },
  };
}

function embeddingEvidenceFrom(
  proximalKnownScams: ClassifierEvidenceContext['proximalKnownScams'],
  diagnostics: EmbeddingDiagnostics,
  config: GuildConfig,
): EvidenceItem {
  const top = proximalKnownScams.find((scam) =>
    scam.source?.endsWith('_embedding'),
  );
  if (!top) return emptyEmbeddingEvidence(diagnostics);
  const threshold =
    top.source === 'image_embedding'
      ? config.knownImageSimilarityThreshold
      : config.knownTextSimilarityThreshold;
  return {
    type: 'embedding_retrieval',
    matched: top.score >= threshold,
    score: top.score,
    summary: `Embedding match to known scam: ${top.scamReason}`,
    metadata: {
      knownScamId: top.id,
      source: top.source,
      threshold,
    },
  };
}

function emptyEmbeddingEvidence(
  diagnostics: EmbeddingDiagnostics,
): EvidenceItem {
  const attempted = [
    diagnostics.textAttempted ? 'text' : null,
    diagnostics.imageAttempted ? 'image' : null,
  ].filter(Boolean);
  const succeeded = [
    diagnostics.textSucceeded ? 'text' : null,
    diagnostics.imageSucceeded > 0
      ? `${diagnostics.imageSucceeded} image`
      : null,
  ].filter(Boolean);

  if (!diagnostics.providerConfigured) {
    return {
      type: 'embedding_retrieval',
      matched: false,
      score: 0,
      summary:
        'Embedding retrieval skipped: no embedding provider is configured.',
      metadata: diagnostics,
    };
  }

  if (attempted.length === 0) {
    return {
      type: 'embedding_retrieval',
      matched: false,
      score: 0,
      summary:
        'Embedding retrieval skipped: no text or image input was available.',
      metadata: diagnostics,
    };
  }

  if (succeeded.length === 0) {
    return {
      type: 'embedding_retrieval',
      matched: false,
      score: 0,
      summary: `Embedding retrieval attempted for ${attempted.join(' and ')}, but no current vectors were returned.`,
      metadata: diagnostics,
    };
  }

  return {
    type: 'embedding_retrieval',
    matched: false,
    score: 0,
    summary: `Embedding retrieval ran with ${succeeded.join(' and ')} vector${succeeded.length === 1 ? '' : 's'}, but found no nearby known-scam vectors.`,
    metadata: diagnostics,
  };
}

function isEmbeddingResult(
  result: EmbeddingResult | null,
): result is EmbeddingResult {
  return result !== null;
}

function analysisFromEvidence(
  evidence: EvidenceItem[],
  config: GuildConfig,
): AnalysisResult {
  const confidence = highestScore(evidence);
  return {
    confidence,
    reason:
      summarizeEvidence(evidence) ||
      'No strong evidence found; requires moderator review.',
    evidence: [...evidence],
    shouldPunish: confidence >= config.evidenceConfidenceThreshold,
  };
}

function highestScore(items: EvidenceItem[]) {
  return items.reduce(
    (max, item) =>
      item.matched && item.metadata?.advisoryOnly !== true
        ? Math.max(max, item.score)
        : max,
    0,
  );
}

function summarizeEvidence(items: EvidenceItem[]) {
  return items
    .filter((item) => item.matched || item.type === 'classifier')
    .sort((a, b) => b.score - a.score)
    .map((item) => `${Math.round(item.score * 100)}% ${item.summary}`)
    .join('\n');
}

function fingerprintKey(message: CachedMessage) {
  const attachmentHashes = message.attachments
    .map((attachment) => attachment.sha256 ?? attachment.id)
    .sort()
    .join(',');
  return `${message.guildId}:${message.textHash ?? message.content}:${attachmentHashes}`;
}
