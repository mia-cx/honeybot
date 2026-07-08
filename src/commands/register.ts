import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type ApplicationCommandDataResolvable,
  type Client,
} from 'discord.js';
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
  {
    ...guildInstallCommand,
    name: 'settings',
    description: 'Open the interactive Honeybot settings panel for this server',
  },
  {
    ...userInstallGuildCommand,
    name: 'admin',
    description: 'Honeybot global admin moderation operations',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'add',
        description: 'Add a retained case to a global Honeybot corpus',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'type',
            description: 'What to add from the retained case',
            required: true,
            choices: [
              { name: 'Global ban', value: 'ban' },
              { name: 'Known scam', value: 'scam' },
            ],
          },
          {
            type: ApplicationCommandOptionType.String,
            name: 'case_id',
            description: 'Honeybot case ID to add',
            required: true,
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'corpus',
        description: 'List the approved known scam corpus',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'type',
            description: 'Corpus item type to show',
            required: false,
            choices: [
              { name: 'All', value: 'all' },
              { name: 'Text', value: 'text' },
              { name: 'Images', value: 'image' },
            ],
          },
          {
            type: ApplicationCommandOptionType.Integer,
            name: 'page',
            description: 'Page number',
            required: false,
            min_value: 1,
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'verbose',
        description: 'Toggle full model request/response console logging',
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
  const staleGlobalCommandCount = existingGlobalCommands.filter(
    (command) => !desiredGlobalCommandKeys.has(commandKey(command)),
  ).size;

  const globalCommands =
    await client.application.commands.set(honeybotCommands);

  logger.info('Application commands refreshed', {
    globalCommandCount: globalCommands.size,
    chatInputCommandCount: globalCommands.filter(
      (command) => command.type === ApplicationCommandType.ChatInput,
    ).size,
    messageContextCommandCount: globalCommands.filter(
      (command) => command.type === ApplicationCommandType.Message,
    ).size,
    staleGlobalCommandCount,
    clearedGuildCommandSets,
    clearedGuildCommandCount,
  });
}

function commandKey(command: {
  name: string;
  type?: ApplicationCommandType | null;
}) {
  return `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`;
}
