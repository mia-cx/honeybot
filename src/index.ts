import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { env } from './env.js';
import { handleMessageCreate } from './events/messageCreate.js';
import { logger } from './logger.js';
import { PlaceholderScamClassifier } from './services/classifier.js';
import { DuplicateDetector } from './services/duplicateDetector.js';
import { NoopGlobalBanList } from './services/globalBanList.js';
import { MessageCache } from './services/messageCache.js';

const config = await loadConfig();
const messageCache = new MessageCache();
const duplicateDetector = new DuplicateDetector();
const classifier = new PlaceholderScamClassifier();
const globalBanList = new NoopGlobalBanList();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  logger.info('Honeybot connected', {
    botUserId: readyClient.user.id,
    guildCount: readyClient.guilds.cache.size,
  });
});

client.on(Events.MessageCreate, (message) => {
  void handleMessageCreate(message, {
    config,
    messageCache,
    duplicateDetector,
    classifier,
    globalBanList,
  }).catch((error: unknown) => {
    logger.error('Unhandled messageCreate error', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

setInterval(() => duplicateDetector.sweep(), 60_000).unref();

await client.login(env.DISCORD_TOKEN);
