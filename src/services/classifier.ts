import type { CachedMessage, ClassificationResult } from '../types.js';

export interface ScamClassifier {
  classify(message: CachedMessage): Promise<ClassificationResult>;
}

export class PlaceholderScamClassifier implements ScamClassifier {
  async classify(message: CachedMessage): Promise<ClassificationResult> {
    void message;

    return {
      verdict: 'needs_review',
      confidence: 0,
      rationale: 'Classifier is not wired yet. This scaffold never auto-punishes from AI output.',
      labels: ['classifier_not_configured'],
    };
  }
}

export { loadClassifierPrompt } from './prompts.js';
