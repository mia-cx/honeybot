import { PermissionFlagsBits, TeamMemberMembershipState, type GuildMember, type Interaction } from 'discord.js';
import type { ConfigStore } from './configStore.js';
import { env } from '../env.js';

type ManagedInteraction = Interaction<'cached'> & { member: GuildMember };

export async function canManageHoneybot(interaction: ManagedInteraction, configStore: ConfigStore) {
  if (await hasGlobalAuthority(interaction)) return true;
  return canManageMember(interaction.member, await configStore.getGuildConfig(interaction.guildId));
}

export function canManageMember(member: GuildMember, config: { moderatorUsers: string[]; moderatorRoles: string[] }) {
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (config.moderatorUsers.includes(member.id)) return true;
  return member.roles.cache.some((role) => config.moderatorRoles.includes(role.id));
}

export function isBypassed(member: GuildMember, config: { moderatorUsers: string[]; moderatorRoles: string[] }) {
  return canManageMember(member, config);
}

export async function hasGlobalAuthority(interaction: Interaction<'cached'>) {
  if (env.GLOBAL_AUTH_MODE === 'users') {
    return env.GLOBAL_AUTH_USER_IDS.split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .includes(interaction.user.id);
  }

  if (!env.GLOBAL_AUTH_TEAM_ID) return false;
  const application = await interaction.client.application?.fetch().catch(() => interaction.client.application);
  if (!application?.owner || !('members' in application.owner)) return false;
  return application.owner.id === env.GLOBAL_AUTH_TEAM_ID && application.owner.members.some((member) => member.id === interaction.user.id && member.membershipState === TeamMemberMembershipState.Accepted);
}
