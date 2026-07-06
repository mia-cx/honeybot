export type ScamAction =
  | {
      type: 'ban';
      deleteMessageSeconds?: number | undefined;
      reason: string;
    }
  | {
      type: 'timeout';
      durationSeconds: number;
      reason: string;
    }
  | {
      type: 'role';
      roleId: string;
      reason: string;
    }
  | {
      type: 'deleteOnly';
      reason: string;
    }
  | {
      type: 'logOnly';
      reason: string;
    };

export type GuildModerationConfig = {
  honeypotChannelIds: string[];
  bypassRoleIds: string[];
  bypassUserIds: string[];
  honeypotTimeoutSeconds: number;
  duplicateWindowSeconds: number;
  duplicateChannelThreshold: number;
  scamAction: ScamAction;
  moderationLogChannelId?: string | undefined;
};

export type BotConfig = {
  guilds: Record<string, GuildModerationConfig>;
  globalBanList: {
    enabled: boolean;
    endpoint: string | null;
  };
};

export type CachedAttachment = {
  id: string;
  name: string | null;
  contentType: string | null;
  size: number;
  url: string;
  proxyUrl: string;
};

export type CachedMessage = {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
  attachments: CachedAttachment[];
  createdAt: Date;
  reason: 'honeypot' | 'duplicate';
};

export type ClassificationResult = {
  verdict: 'scam' | 'not_scam' | 'needs_review';
  confidence: number;
  rationale: string;
  labels: string[];
};
