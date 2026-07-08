export const policyScopes = [
  'honeypot_prevention',
  'crosschannel_prevention',
  'punishment',
] as const;
export type PolicyScope = (typeof policyScopes)[number];

export const preventionActions = [
  'log',
  'timeout',
  'role',
  'kick',
  'ban',
] as const;
export type PreventionAction = (typeof preventionActions)[number];

export const punishmentActions = ['timeout', 'role', 'kick', 'ban'] as const;
export type PunishmentAction = (typeof punishmentActions)[number];
export type PolicyAction = PreventionAction | PunishmentAction;

export const caseStatuses = [
  'pending_review',
  'punished',
  'dismissed',
  'reverted',
] as const;
export type CaseStatus = (typeof caseStatuses)[number];

export type TriggerType = 'honeypot' | 'crosschannel';

export type Policy = {
  scope: PolicyScope;
  actionType: PolicyAction;
  durationSeconds: number | null;
  roleId: string | null;
  deleteMessages: boolean;
};

export type GuildSettings = {
  moderationChannelId: string | null;
  crosschannelEnabled: boolean;
  crosschannelWindowSeconds: number;
  crosschannelChannelThreshold: number;
  knownImageSimilarityThreshold: number;
  knownTextSimilarityThreshold: number;
  evidenceConfidenceThreshold: number;
  reviewBypassEnabled: boolean;
  punishmentDmNotify: boolean;
  retentionCaseDays: number;
  crosschannelMaxEntriesPerGuild: number;
  crosschannelMaxEntriesPerUser: number;
  globalBansEnabled: boolean;
};

export type GuildConfig = GuildSettings & {
  policies: Record<PolicyScope, Policy>;
  honeypotChannelIds: string[];
  moderatorUsers: string[];
  moderatorRoles: string[];
};

export type StoredAttachment = {
  id: number;
  discordAttachmentId: string;
  name: string | null;
  contentType: string | null;
  sizeBytes: number;
  sha256: string | null;
  storageKey: string | null;
  originalUrl: string;
};

export type EvidenceItem = {
  type:
    | 'exact_match'
    | 'fuzzy_match'
    | 'embedding_retrieval'
    | 'classifier'
    | 'manual_review';
  matched: boolean;
  score: number;
  summary: string;
  metadata?: Record<string, unknown>;
};

export type AnalysisResult = {
  confidence: number;
  reason: string;
  evidence: EvidenceItem[];
  shouldPunish: boolean;
};

export type ProximalKnownScamImage = {
  id: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  dataUrl: string;
};

export type ProximalKnownScam = {
  id: string;
  sourceCaseId: string | null;
  score: number;
  source?: 'text_embedding' | 'image_embedding' | 'text_fuzzy';
  description: string;
  scamReason: string;
  normalizedText: string | null;
  images: ProximalKnownScamImage[];
};

export type ClassifierEvidenceContext = {
  evidenceSummary: string;
  proximalKnownScams: ProximalKnownScam[];
};

export type ModelPurpose =
  | 'text_classifier'
  | 'image_classifier'
  | 'text_embeddings'
  | 'image_embeddings';
