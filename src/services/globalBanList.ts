import type { CachedMessage, ClassificationResult } from '../types.js';

export interface GlobalBanList {
  reportScam(message: CachedMessage, classification: ClassificationResult): Promise<void>;
}

export class NoopGlobalBanList implements GlobalBanList {
  async reportScam(message: CachedMessage, classification: ClassificationResult) {
    void message;
    void classification;
  }
}
