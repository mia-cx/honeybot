export type CachedAttachment = {
  id: string;
  name: string | null;
  contentType: string | null;
  size: number;
  url: string;
  proxyUrl: string;
  sha256: string | null;
  storageKey: string | null;
};

export type CachedMessage = {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
  normalizedContent: string;
  textHash: string | null;
  attachments: CachedAttachment[];
  createdAt: Date;
  reason: 'honeypot' | 'crosschannel';
};

export type ClassificationResult = {
  verdict: 'scam' | 'not_scam' | 'needs_review';
  confidence: number;
  rationale: string;
  labels: string[];
};
