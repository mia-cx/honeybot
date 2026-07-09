import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  defaultGuildInstallUrl,
  guildInstallPermissionFlags,
  guildInstallPermissions,
  guildInstallScopes,
  userInstallScopes,
} from '../src/services/installSettings.js';

describe('default Discord install settings', () => {
  it('matches the developer-portal install scopes', () => {
    expect(userInstallScopes).toEqual(['applications.commands']);
    expect(guildInstallScopes).toEqual(['applications.commands', 'bot']);
  });

  it('matches the developer-portal guild permissions', () => {
    expect(guildInstallPermissionFlags).toEqual([
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
    ]);
    expect(guildInstallPermissions).toMatch(/^\d+$/);
  });

  it('builds the default guild OAuth install URL', () => {
    const url = new URL(defaultGuildInstallUrl('123'));

    expect(url.origin).toBe('https://discord.com');
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('123');
    expect(url.searchParams.get('scope')).toBe('applications.commands bot');
    expect(url.searchParams.get('permissions')).toBe(guildInstallPermissions);
  });
});
