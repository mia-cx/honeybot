import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';
import { registerCommands } from './commands/register.js';
import { openDatabase } from './db/database.js';
import { deploymentGuildDefaults, env } from './env.js';
import { handleInteractionCreate } from './events/interactionCreate.js';
import { handleMessageCreate } from './events/messageCreate.js';
import { logger } from './logger.js';
import { FairQueue } from './queues/fairQueue.js';
import { CaseStore } from './services/caseStore.js';
import { OpenRouterScamClassifier } from './services/classifier.js';
import { ConfigStore } from './services/configStore.js';
import { DuplicateDetector } from './services/duplicateDetector.js';
import { OpenRouterEmbeddings } from './services/embeddings.js';
import { EvidenceAnalyzer } from './services/evidenceAnalyzer.js';
import { GlobalBanService } from './services/globalBanList.js';
import { MessageCache } from './services/messageCache.js';
import { ModelStore } from './services/modelStore.js';
import { FileStorage } from './storage/fileStorage.js';

const EPHEMERAL = 1 << 6;

const database = openDatabase(env.DATABASE_URL);
const storage = new FileStorage(env.IMAGE_STORAGE_DIR);
const configStore = new ConfigStore(database.db, deploymentGuildDefaults);
const modelStore = new ModelStore(database.db, {
  text_classifier: {
    provider: env.DEFAULT_TEXT_PRIMARY_PROVIDER,
    modelId: env.DEFAULT_TEXT_PRIMARY_MODEL,
  },
  image_classifier: {
    provider: env.DEFAULT_IMAGE_PRIMARY_PROVIDER,
    modelId: env.DEFAULT_IMAGE_PRIMARY_MODEL,
  },
  text_embeddings: {
    provider: env.DEFAULT_TEXT_EMBEDDINGS_PROVIDER,
    modelId: env.DEFAULT_TEXT_EMBEDDINGS_MODEL,
  },
  image_embeddings: {
    provider: env.DEFAULT_IMAGE_EMBEDDINGS_PROVIDER,
    modelId: env.DEFAULT_IMAGE_EMBEDDINGS_MODEL,
  },
  apiKeys: { openrouter: env.OPENROUTER_API_KEY ?? null },
  encryptionKeyBase64: env.API_KEY_ENCRYPTION_KEY ?? null,
});
const messageCache = new MessageCache();
const duplicateDetector = new DuplicateDetector();
const modelQueue = new FairQueue({
  name: 'models',
  globalLimit: env.MODEL_CALL_LIMIT,
  perGuildLimit: env.MODEL_CALL_LIMIT_PER_GUILD,
  windowMs: env.MODEL_CALL_WINDOW_SECONDS * 1000,
});
const moderationQueue = new FairQueue({
  name: 'moderation',
  globalLimit: env.MODERATION_ACTION_LIMIT,
  perGuildLimit: env.MODERATION_ACTION_LIMIT_PER_GUILD,
  windowMs: env.MODERATION_ACTION_WINDOW_SECONDS * 1000,
});
const embedder = new OpenRouterEmbeddings(
  modelStore,
  modelQueue,
  env.DEFAULT_EMBEDDINGS_DIMENSIONS,
);
const caseStore = new CaseStore(database.db, storage, embedder);
const classifier = new OpenRouterScamClassifier(modelStore, modelQueue, {
  text: {
    provider: env.ADDITIONAL_TEXT_SIGNAL_PROVIDER,
    models: env.ADDITIONAL_TEXT_SIGNAL_MODELS,
  },
  image: {
    provider: env.ADDITIONAL_IMAGE_SIGNAL_PROVIDER,
    models: env.ADDITIONAL_IMAGE_SIGNAL_MODELS,
  },
});
const analyzer = new EvidenceAnalyzer(caseStore, classifier, embedder);
const globalBanService = new GlobalBanService(
  database.db,
  configStore,
  moderationQueue,
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  readyClient.user.setPresence({
    status: 'idle',
    activities: [
      {
        name: 'catching scammers',
        type: ActivityType.Custom,
        state: 'catching scammers',
      },
    ],
  });

  void Promise.all(
    [...readyClient.guilds.cache.keys()].map((guildId) =>
      configStore.initializeGuildDefaults(guildId),
    ),
  )
    .then(() => configStore.purgeExpiredRemovedGuildSettings())
    .then((purgedGuildCount) => {
      if (purgedGuildCount > 0)
        logger.info('Purged expired removed-guild settings', {
          purgedGuildCount,
        });
    })
    .then(() => registerCommands(readyClient))
    .then(() => {
      logger.info('Honeybot connected', {
        botUserId: readyClient.user.id,
        guildCount: readyClient.guilds.cache.size,
      });
    })
    .catch((error: unknown) => {
      logger.error('Failed to initialize Honeybot', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
});

client.on(Events.MessageCreate, (message) => {
  void handleMessageCreate(message, {
    configStore,
    messageCache,
    duplicateDetector,
    caseStore,
    analyzer,
    moderationQueue,
    storage,
  }).catch((error: unknown) => {
    logger.error('Unhandled messageCreate error', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  void handleInteractionCreate(interaction, {
    configStore,
    modelStore,
    caseStore,
    db: database.db,
    moderationQueue,
    storage,
    additionalSignalModels: {
      text: {
        provider: env.ADDITIONAL_TEXT_SIGNAL_PROVIDER,
        models: env.ADDITIONAL_TEXT_SIGNAL_MODELS,
      },
      image: {
        provider: env.ADDITIONAL_IMAGE_SIGNAL_PROVIDER,
        models: env.ADDITIONAL_IMAGE_SIGNAL_MODELS,
      },
    },
  }).catch((error: unknown) => {
    logger.error('Unhandled interactionCreate error', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      void interaction
        .reply({
          content: 'Honeybot hit an error handling that interaction.',
          flags: EPHEMERAL,
        })
        .catch(() => undefined);
    }
  });
});

client.on(Events.GuildCreate, (guild) => {
  void configStore
    .initializeGuildDefaults(guild.id)
    .then(() =>
      logger.info('Initialized guild defaults', { guildId: guild.id }),
    )
    .catch((error: unknown) => {
      logger.error('Unhandled guildCreate error', {
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
});

client.on(Events.GuildDelete, (guild) => {
  void configStore
    .markGuildRemoved(guild.id)
    .then(() =>
      logger.info('Marked guild settings for retention', { guildId: guild.id }),
    )
    .catch((error: unknown) => {
      logger.error('Unhandled guildDelete error', {
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
});

client.on(Events.GuildMemberAdd, (member) => {
  void globalBanService.handleJoin(member).catch((error: unknown) => {
    logger.error('Unhandled guildMemberAdd error', {
      guildId: member.guild.id,
      userId: member.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

setInterval(() => duplicateDetector.sweep(), 60_000).unref();
setInterval(
  () => {
    void configStore
      .purgeExpiredRemovedGuildSettings()
      .catch((error: unknown) => {
        logger.error('Failed to purge expired removed-guild settings', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  },
  24 * 60 * 60 * 1000,
).unref();

await client.login(env.DISCORD_TOKEN);
