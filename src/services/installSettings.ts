import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';

export const userInstallScopes = ['applications.commands'] as const;

export const guildInstallScopes = ['applications.commands', 'bot'] as const;

export const guildInstallPermissionFlags = [
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ViewChannel,
] as const;

export const guildInstallPermissions = new PermissionsBitField(
  guildInstallPermissionFlags,
).bitfield.toString();

export function defaultGuildInstallUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: guildInstallScopes.join(' '),
    permissions: guildInstallPermissions,
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
