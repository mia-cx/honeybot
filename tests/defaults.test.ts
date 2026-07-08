import { describe, expect, it } from 'vitest';
import { defaultGuildConfig } from '../src/domain/defaults.js';

describe('fresh guild defaults', () => {
  it('matches the settled moderation defaults', () => {
    const config = defaultGuildConfig();

    expect(config.policies.honeypot_prevention).toMatchObject({
      actionType: 'timeout',
      durationSeconds: 21_600,
      deleteMessages: true,
    });
    expect(config.policies.crosschannel_prevention).toMatchObject({
      actionType: 'timeout',
      durationSeconds: 1_800,
      deleteMessages: true,
    });
    expect(config.policies.punishment).toMatchObject({
      actionType: 'ban',
      deleteMessages: true,
    });
    expect(config.reviewBypassEnabled).toBe(false);
    expect(config.punishmentDmNotify).toBe(true);
    expect(config.evidenceConfidenceThreshold).toBe(0.9);
    expect(config.retentionCaseDays).toBe(180);
  });
});
