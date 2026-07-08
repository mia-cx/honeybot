import type { CaseStore } from './caseStore.js';
import type { ScamClassifier } from './classifier.js';
import type { AnalysisResult, EvidenceItem, GuildConfig } from '../domain/types.js';
import type { CachedMessage } from '../types.js';

export class EvidenceAnalyzer {
  private readonly cache = new Map<string, AnalysisResult>();

  constructor(
    private readonly caseStore: CaseStore,
    private readonly classifier: ScamClassifier,
  ) {}

  async analyze(caseId: string, cached: CachedMessage, config: GuildConfig): Promise<AnalysisResult> {
    const cacheKey = fingerprintKey(cached);
    const cachedResult = this.cache.get(cacheKey);
    if (cachedResult) return cachedResult;

    const evidence: EvidenceItem[] = [];

    if (cached.textHash) {
      const knownText = await this.caseStore.findKnownTextByHash(cached.guildId, cached.textHash);
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
      const knownImage = await this.caseStore.findKnownImageBySha(cached.guildId, attachment.sha256);
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

    const decisive = highestScore(evidence) >= config.evidenceConfidenceThreshold;
    if (!decisive) {
      const classifierResult = await this.classifier.classify(cached, summarizeEvidence(evidence)).catch((error: unknown) => ({
        verdict: 'needs_review' as const,
        confidence: 0,
        rationale: `Classifier unavailable: ${error instanceof Error ? error.message : String(error)}`,
        labels: [],
      }));
      evidence.push({
        type: 'classifier',
        matched: classifierResult.verdict === 'scam',
        score: classifierResult.verdict === 'scam' ? classifierResult.confidence : 0,
        summary: classifierResult.rationale,
        metadata: { verdict: classifierResult.verdict },
      });
    }

    const confidence = highestScore(evidence);
    const reason = summarizeEvidence(evidence) || 'No strong evidence found; requires moderator review.';
    const result = { confidence, reason, evidence, shouldPunish: confidence >= config.evidenceConfidenceThreshold };
    await this.caseStore.saveAnalysis(caseId, result);
    this.cache.set(cacheKey, result);
    return result;
  }
}

function highestScore(items: EvidenceItem[]) {
  return items.reduce((max, item) => (item.matched ? Math.max(max, item.score) : max), 0);
}

function summarizeEvidence(items: EvidenceItem[]) {
  return items
    .filter((item) => item.matched || item.type === 'classifier')
    .sort((a, b) => b.score - a.score)
    .map((item) => `${Math.round(item.score * 100)}% ${item.summary}`)
    .join('\n');
}

function fingerprintKey(message: CachedMessage) {
  const attachmentHashes = message.attachments.map((attachment) => attachment.sha256 ?? attachment.id).sort().join(',');
  return `${message.guildId}:${message.textHash ?? message.content}:${attachmentHashes}`;
}
