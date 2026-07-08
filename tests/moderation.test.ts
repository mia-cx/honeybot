import { describe, expect, it } from 'vitest';
import type { Policy } from '../src/domain/types.js';
import { honeybotAuditReason, moderationAuditReason } from '../src/services/moderation.js';

const basePolicy: Policy = {
  scope: 'punishment',
  actionType: 'ban',
  durationSeconds: null,
  roleId: null,
  deleteMessages: true,
};

describe('moderation audit reasons', () => {
  it('formats case audit reasons', () => {
    expect(honeybotAuditReason({ caseId: 'Ab3', triggerType: 'honeypot', decisionSource: 'mod-approved', confidence: 0.94, actorId: '123' })).toBe(
      'Honeybot case Ab3 · honeypot · mod-approved · 94% · actor=123',
    );
  });

  it('prefixes ban reasons', () => {
    expect(moderationAuditReason(basePolicy, 'Honeybot case Ab3 · honeypot · mod-approved · 94% · actor=123')).toBe(
      'Banned for likely scam • Honeybot case Ab3 · honeypot · mod-approved · 94% · actor=123',
    );
  });

  it('prefixes kick reasons', () => {
    expect(moderationAuditReason({ ...basePolicy, actionType: 'kick' }, 'Honeybot case Ab3 · honeypot · mod-approved · 94% · actor=123')).toBe(
      'Kicked for likely scam • Honeybot case Ab3 · honeypot · mod-approved · 94% · actor=123',
    );
  });

  it('does not prefix non-removal actions', () => {
    expect(moderationAuditReason({ ...basePolicy, actionType: 'timeout' }, 'Honeybot case Ab3')).toBe('Honeybot case Ab3');
  });
});
