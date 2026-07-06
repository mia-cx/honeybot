import { PermissionFlagsBits, type GuildMember, type Message } from 'discord.js';
import { logger } from '../logger.js';
import type { GuildModerationConfig } from '../types.js';

const DISCORD_MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;

export function hasBypass(member: GuildMember, config: GuildModerationConfig) {
  if (config.bypassUserIds.includes(member.id)) return true;
  if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return true;

  return member.roles.cache.some((role) => config.bypassRoleIds.includes(role.id));
}

export async function applyImmediateHoneypotTimeout(
  member: GuildMember,
  config: GuildModerationConfig,
) {
  const seconds = Math.min(config.honeypotTimeoutSeconds, DISCORD_MAX_TIMEOUT_SECONDS);
  await member.timeout(seconds * 1000, 'Posted in honeypot channel');
}

export async function deleteMessage(message: Message<true>) {
  if (!message.deletable) return;
  await message.delete();
}

export async function applyScamAction(member: GuildMember, config: GuildModerationConfig) {
  switch (config.scamAction.type) {
    case 'ban': {
      const options = {
        reason: config.scamAction.reason,
        ...(config.scamAction.deleteMessageSeconds === undefined
          ? {}
          : { deleteMessageSeconds: config.scamAction.deleteMessageSeconds }),
      };
      await member.guild.members.ban(member.id, options);
      return;
    }
    case 'timeout':
      await member.timeout(config.scamAction.durationSeconds * 1000, config.scamAction.reason);
      return;
    case 'role':
      await member.roles.add(config.scamAction.roleId, config.scamAction.reason);
      return;
    case 'deleteOnly':
    case 'logOnly':
      logger.info('Scam action did not mutate member', {
        guildId: member.guild.id,
        userId: member.id,
        action: config.scamAction.type,
      });
      return;
  }
}
