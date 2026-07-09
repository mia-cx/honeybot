import {
  AttachmentBuilder,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
  type GuildMember,
  type Message,
} from 'discord.js';
import { logger } from '../logger.js';
import type { GuildConfig, Policy } from '../domain/types.js';
import type { CaseStore } from './caseStore.js';
import type { FileStorage } from '../storage/fileStorage.js';

const COMPONENTS_V2 = 1 << 15;
const DISCORD_MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;
const BAN_DELETE_SECONDS = 7 * 24 * 60 * 60;

type RawComponent = { type: number; [key: string]: unknown };

export function hasBypass(member: GuildMember, config: GuildConfig) {
  if (member.id === member.guild.ownerId) return true;
  if (config.moderatorUsers.includes(member.id)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((role) =>
    config.moderatorRoles.includes(role.id),
  );
}

export async function applyPolicy(
  member: GuildMember,
  policy: Policy,
  reason: string,
) {
  return applyPolicyForUser(member.guild, member.id, policy, reason);
}

export async function applyPolicyForUser(
  guild: Guild,
  userId: string,
  policy: Policy,
  reason: string,
) {
  switch (policy.actionType) {
    case 'log':
      return 'log action applied';
    case 'timeout': {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member)
        return 'timeout could not be applied because the member is no longer in the guild';
      const seconds = Math.min(
        policy.durationSeconds ?? 1_800,
        DISCORD_MAX_TIMEOUT_SECONDS,
      );
      await member.timeout(seconds * 1000, reason);
      return 'timeout applied';
    }
    case 'role': {
      if (!policy.roleId) throw new Error('Role policy missing role_id');
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member)
        return 'role could not be applied because the member is no longer in the guild';
      await member.roles.add(policy.roleId, reason);
      return 'role applied';
    }
    case 'kick': {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member)
        return 'kick could not be applied because the member is no longer in the guild';
      await member.kick(moderationAuditReason(policy, reason));
      return 'user kicked';
    }
    case 'ban':
      await guild.members.ban(userId, {
        reason: moderationAuditReason(policy, reason),
        deleteMessageSeconds: policy.deleteMessages ? BAN_DELETE_SECONDS : 0,
      });
      return 'user banned';
  }
}

export function honeybotAuditReason(input: {
  caseId: string;
  triggerType: string;
  decisionSource: string;
  confidence: number | null;
  actorId: string | null;
}) {
  const confidence =
    input.confidence === null
      ? 'pending'
      : `${Math.round(input.confidence * 100)}%`;
  const actor = input.actorId ? `actor=${input.actorId}` : 'actor=bot';
  return `Honeybot case ${input.caseId} · ${input.triggerType} · ${input.decisionSource} · ${confidence} · ${actor}`;
}

export function moderationAuditReason(policy: Policy, reason: string) {
  const prefix =
    policy.actionType === 'ban'
      ? 'Banned for likely scam • '
      : policy.actionType === 'kick'
        ? 'Kicked for likely scam • '
        : '';
  return truncate(`${prefix}${reason}`, 512);
}

export async function revertPolicy(
  member: GuildMember,
  policy: Policy,
  reason: string,
) {
  return revertPolicyForUser(member.guild, member.id, policy, reason);
}

export async function revertPolicyForUser(
  guild: Guild,
  userId: string,
  policy: Policy,
  reason: string,
) {
  switch (policy.actionType) {
    case 'timeout': {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member)
        return 'timeout could not be removed because the member is no longer in the guild';
      await member.timeout(null, reason);
      return 'timeout removed';
    }
    case 'role': {
      if (!policy.roleId) return 'role policy had no role';
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member)
        return 'role could not be removed because the member is no longer in the guild';
      await member.roles.remove(policy.roleId, reason);
      return 'role removed';
    }
    case 'ban':
      await guild.members.unban(userId, reason);
      return 'user unbanned';
    case 'kick':
      return 'kick cannot be undone';
    case 'log':
      return 'log action needs no revert';
  }
}

export async function deleteMessage(message: Message<true>) {
  if (!message.deletable) return false;
  await message.delete();
  return true;
}

export async function applyPolicyWithBestEffortDm(input: {
  guild: Guild;
  userId: string;
  policy: Policy;
  reason: string;
  dm: {
    caseId: string;
    reason: string;
    auditReason?: string;
    caseStore: CaseStore;
    storage: FileStorage;
  } | null;
}) {
  if (input.dm) {
    let dmSent = false;
    try {
      dmSent = await dmPunishedUser({
        guild: input.guild,
        userId: input.userId,
        caseId: input.dm.caseId,
        action: input.policy.actionType,
        reason: input.dm.reason,
        ...(input.dm.auditReason === undefined
          ? {}
          : { auditReason: input.dm.auditReason }),
        caseStore: input.dm.caseStore,
        storage: input.dm.storage,
      });
    } catch (error) {
      logger.warn('Punishment DM attempt failed unexpectedly', {
        guildId: input.guild.id,
        userId: input.userId,
        caseId: input.dm.caseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!dmSent) {
      logger.info('Continuing punishment after DM delivery failure', {
        guildId: input.guild.id,
        userId: input.userId,
        caseId: input.dm.caseId,
      });
    }
  }

  return applyPolicyForUser(
    input.guild,
    input.userId,
    input.policy,
    input.reason,
  );
}

export async function dmPunishedUser(input: {
  guild: Guild;
  userId: string;
  caseId: string;
  action: string;
  reason: string;
  auditReason?: string;
  caseStore: CaseStore;
  storage: FileStorage;
}) {
  let member: GuildMember;
  try {
    member = await input.guild.members.fetch({
      user: input.userId,
      force: true,
    });
  } catch (error) {
    const detail = isUnknownMemberError(error)
      ? 'Cannot DM user because they are no longer in the guild'
      : `Cannot fetch user for punishment DM: ${error instanceof Error ? error.message : String(error)}`;
    const context = {
      guildId: input.guild.id,
      userId: input.userId,
      error: detail,
    };
    if (isUnknownMemberError(error)) {
      logger.info('Skipped punishment DM for user outside guild', context);
    } else {
      logger.warn('Failed to fetch punished user for DM', context);
    }
    await recordDmFailure(input, detail, []);
    return false;
  }

  const messages = await input.caseStore.listCaseMessages(input.caseId);
  const attachments = await input.caseStore.listCaseAttachments(input.caseId);
  const firstMessage = messages[0];
  const files = [] as Array<{
    filename: string;
    attachment: AttachmentBuilder;
  }>;
  const omitted: string[] = [];

  for (const attachment of attachments.slice(0, 8)) {
    if (!attachment.storageKey) continue;
    if (
      !attachment.contentType?.startsWith('image/') ||
      attachment.sizeBytes > 8 * 1024 * 1024
    ) {
      omitted.push(attachment.discordAttachmentId);
      continue;
    }
    const filename = `SPOILER_${attachment.id}_${safeName(attachment.name ?? `${attachment.discordAttachmentId}.bin`)}`;
    files.push({
      filename,
      attachment: new AttachmentBuilder(
        input.storage.pathFor(attachment.storageKey),
        { name: filename },
      ),
    });
  }

  try {
    await member.send({
      flags: COMPONENTS_V2,
      files: files.map((file) => file.attachment),
      components: punishmentDmComponents(
        input,
        firstMessage?.content ?? '',
        files.map((file) => file.filename),
      ),
      allowedMentions: { parse: [] },
    });
    await input.caseStore.addEvent(
      input.caseId,
      'dm_notified',
      'bot',
      null,
      'Punishment DM sent',
      { omitted },
    );
    return true;
  } catch (error) {
    logger.warn('Failed to DM punished user', {
      guildId: input.guild.id,
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    await recordDmFailure(
      input,
      error instanceof Error ? error.message : String(error),
      omitted,
    );
    return false;
  }
}

function isUnknownMemberError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === RESTJSONErrorCodes.UnknownMember
  );
}

async function recordDmFailure(
  input: Pick<Parameters<typeof dmPunishedUser>[0], 'caseId' | 'caseStore'>,
  error: string,
  omitted: string[],
) {
  await input.caseStore.addEvent(
    input.caseId,
    'failed',
    'bot',
    null,
    'Punishment DM failed',
    { error, omitted },
  );
}

function punishmentDmComponents(
  input: {
    guild: Guild;
    caseId: string;
    action: string;
    reason: string;
    auditReason?: string;
  },
  messageContent: string,
  attachmentFilenames: string[],
): RawComponent[] {
  const components: RawComponent[] = [
    text(
      `## 🍯 Honeybot moderation notice\n-# Server: **${input.guild.name}** · Case \`${input.caseId}\``,
    ),
    separator(),
    text(
      [
        '## Punishment',
        `**Action:** ${actionLabel(input.action)}`,
        '',
        '**Reason**',
        quote(input.auditReason ?? input.reason, 900),
      ].join('\n'),
    ),
    separator(),
    text(
      [
        '## Message that triggered this',
        messageContent
          ? quote(messageContent, 1500)
          : '_empty or attachment-only_',
      ].join('\n'),
    ),
  ];

  if (attachmentFilenames.length > 0)
    components.push(mediaGallery(attachmentFilenames));

  return [container(components)];
}

function container(components: RawComponent[]): RawComponent {
  return { type: 17, accent_color: 0xfacc15, components };
}

function text(content: string): RawComponent {
  return { type: 10, content };
}

function separator(): RawComponent {
  return { type: 14, divider: true, spacing: 1 };
}

function mediaGallery(attachmentFilenames: string[]): RawComponent {
  return {
    type: 12,
    items: attachmentFilenames.slice(0, 10).map((filename) => ({
      media: { url: `attachment://${filename}` },
      description: `Evidence attachment ${filename.replace(/^SPOILER_/, '')}`,
      spoiler: true,
    })),
  };
}

function actionLabel(action: string) {
  switch (action) {
    case 'ban':
      return 'Banned';
    case 'kick':
      return 'Kicked';
    case 'timeout':
      return 'Timed out';
    case 'role':
      return 'Role applied';
    default:
      return action;
  }
}

function quote(value: string, max: number) {
  return `> ${truncate(value, max).replace(/\n/g, '\n> ')}`;
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'attachment.bin';
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
