import { ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, type ApplicationCommandDataResolvable, type Client } from 'discord.js';
import { logger } from '../logger.js';

const guildInstallCommand = {
  integrationTypes: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],
} as const;

const userInstallGuildCommand = {
  integrationTypes: [ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.Guild],
} as const;

const honeybotCommands = [
  { ...guildInstallCommand, name: 'settings', description: 'Open the interactive Honeybot settings panel for this server' },
  {
    ...guildInstallCommand,
    name: 'honeypot',
    description: 'Manage trap channels where any user post opens a moderation case',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'add',
        description: 'Add a trap channel that immediately triggers honeypot prevention',
        options: [{ type: ApplicationCommandOptionType.Channel, name: 'channel', description: 'Text channel to treat as a honeypot trap', required: true }],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'remove',
        description: 'Remove a channel from honeypot detection',
        options: [{ type: ApplicationCommandOptionType.Channel, name: 'channel', description: 'Text channel to stop treating as a honeypot', required: true }],
      },
      { type: ApplicationCommandOptionType.Subcommand, name: 'list', description: 'Show every channel currently configured as a honeypot' },
    ],
  },
  {
    ...guildInstallCommand,
    name: 'moderators',
    description: 'Manage users and roles that can configure Honeybot and bypass scans',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'add-user',
        description: 'Allow one user to configure Honeybot and bypass automated scans',
        options: [{ type: ApplicationCommandOptionType.User, name: 'user', description: 'User to grant Honeybot moderator access', required: true }],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'add-role',
        description: 'Allow a role to configure Honeybot and bypass automated scans',
        options: [{ type: ApplicationCommandOptionType.Role, name: 'role', description: 'Role to grant Honeybot moderator access', required: true }],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'remove-user',
        description: 'Remove one user from Honeybot moderator access',
        options: [{ type: ApplicationCommandOptionType.User, name: 'user', description: 'User to remove from Honeybot moderators', required: true }],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'remove-role',
        description: 'Remove one role from Honeybot moderator access',
        options: [{ type: ApplicationCommandOptionType.Role, name: 'role', description: 'Role to remove from Honeybot moderators', required: true }],
      },
      { type: ApplicationCommandOptionType.Subcommand, name: 'list', description: 'Show users and roles with Honeybot moderator access' },
    ],
  },
  {
    ...guildInstallCommand,
    name: 'policies',
    description: 'Configure immediate prevention and final punishment actions',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'set',
        description: 'Set one prevention or punishment policy for this server',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'scope',
            description: 'Which policy to update: trigger prevention or final punishment',
            required: true,
            choices: ['honeypot_prevention', 'crosschannel_prevention', 'punishment'].map((name) => ({ name, value: name })),
          },
          {
            type: ApplicationCommandOptionType.String,
            name: 'action',
            description: 'Action Honeybot should apply for this policy',
            required: true,
            choices: ['log', 'timeout', 'role', 'kick', 'ban'].map((name) => ({ name, value: name })),
          },
          { type: ApplicationCommandOptionType.Integer, name: 'duration', description: 'Timeout duration in seconds when action is timeout', required: false },
          { type: ApplicationCommandOptionType.Role, name: 'role', description: 'Role to add/remove when action is role', required: false },
          { type: ApplicationCommandOptionType.Boolean, name: 'delete_messages', description: 'Whether prevention should delete triggering messages', required: false },
        ],
      },
      { type: ApplicationCommandOptionType.Subcommand, name: 'list', description: 'Show prevention and punishment policies for this server' },
    ],
  },
  {
    ...guildInstallCommand,
    name: 'model',
    description: 'Configure classifier and embedding model overrides',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'set',
        description: 'Set provider/model and optionally open a secure API-key modal',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'purpose',
            description: 'Pipeline purpose this model is used for',
            required: true,
            choices: ['text_classifier', 'image_classifier', 'text_embeddings', 'image_embeddings'].map((name) => ({ name, value: name })),
          },
          { type: ApplicationCommandOptionType.String, name: 'provider', description: 'Model provider, defaults to openrouter', required: false },
          { type: ApplicationCommandOptionType.String, name: 'model_id', description: 'Provider model identifier, or blank for default', required: false },
          { type: ApplicationCommandOptionType.Boolean, name: 'enter_api_key', description: 'Open a modal so the key is never shown in chat', required: false },
        ],
      },
      { type: ApplicationCommandOptionType.Subcommand, name: 'list', description: 'Show model overrides and redacted key status' },
      { type: ApplicationCommandOptionType.Subcommand, name: 'keys', description: 'Show only redacted API-key hints for each model purpose' },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'clear-key',
        description: 'Remove the stored per-server API key for one model purpose',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'purpose',
            description: 'Model purpose whose stored API key should be removed',
            required: true,
            choices: ['text_classifier', 'image_classifier', 'text_embeddings', 'image_embeddings'].map((name) => ({ name, value: name })),
          },
        ],
      },
    ],
  },
  {
    ...userInstallGuildCommand,
    name: 'honeybot-team',
    description: 'Honeybot team global moderation operations',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'global-ban',
        description: 'Publish a retained Honeybot case to the global ban list',
        options: [{ type: ApplicationCommandOptionType.String, name: 'case_id', description: 'Honeybot case ID to publish globally', required: true }],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'known-scam',
        description: 'Promote a retained Honeybot case message and images to global known scams',
        options: [{ type: ApplicationCommandOptionType.String, name: 'case_id', description: 'Honeybot case ID to promote globally', required: true }],
      },
    ],
  },
  {
    ...userInstallGuildCommand,
    type: ApplicationCommandType.Message,
    name: 'Mark case as known scam',
  },
  {
    ...userInstallGuildCommand,
    type: ApplicationCommandType.Message,
    name: 'Ban transgressor globally',
  },
  {
    ...guildInstallCommand,
    name: 'global-bans',
    description: 'Choose whether this server consumes operator-published global bans',
    options: [
      { type: ApplicationCommandOptionType.Subcommand, name: 'status', description: 'Show whether this server consumes global bans' },
      { type: ApplicationCommandOptionType.Subcommand, name: 'opt-in', description: 'Ban users when they appear on the global ban list' },
      { type: ApplicationCommandOptionType.Subcommand, name: 'opt-out', description: 'Stop applying global bans to this server' },
    ],
  },
] satisfies ApplicationCommandDataResolvable[];

export async function registerCommands(client: Client<true>) {
  let clearedGuildCommandSets = 0;
  let clearedGuildCommandCount = 0;

  for (const guild of client.guilds.cache.values()) {
    const existingGuildCommands = await guild.commands.fetch();
    if (existingGuildCommands.size === 0) continue;

    await guild.commands.set([]);
    clearedGuildCommandSets += 1;
    clearedGuildCommandCount += existingGuildCommands.size;
  }

  const existingGlobalCommands = await client.application.commands.fetch();
  const desiredGlobalCommandKeys = new Set(honeybotCommands.map(commandKey));
  const staleGlobalCommandCount = existingGlobalCommands.filter((command) => !desiredGlobalCommandKeys.has(commandKey(command))).size;

  const globalCommands = await client.application.commands.set(honeybotCommands);

  logger.info('Application commands refreshed', {
    globalCommandCount: globalCommands.size,
    chatInputCommandCount: globalCommands.filter((command) => command.type === ApplicationCommandType.ChatInput).size,
    messageContextCommandCount: globalCommands.filter((command) => command.type === ApplicationCommandType.Message).size,
    staleGlobalCommandCount,
    clearedGuildCommandSets,
    clearedGuildCommandCount,
  });
}

function commandKey(command: { name: string; type?: ApplicationCommandType | null }) {
  return `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`;
}
