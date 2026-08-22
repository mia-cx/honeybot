import { EmbedBuilder } from 'discord.js';
import type { HoneybotInfo } from '../services/info.js';

const SOURCE_URL = 'https://github.com/mia-cx/honeybot';

export function infoReply(info: HoneybotInfo, showDiagnostics: boolean) {
  const classifiers = info.models.filter(({ purpose }) =>
    purpose.endsWith('_classifier'),
  );
  const modelsReady = info.models.every(({ ready }) => ready);
  const corpusHealthy = info.corpus.missingEmbeddings === 0;
  const startedAt = Math.floor(info.startedAt.getTime() / 1_000);

  const embed = new EmbedBuilder()
    .setColor(modelsReady && corpusHealthy ? 0xf5b82e : 0xe67e22)
    .setTitle('🍯 Honeybot info')
    .setDescription(
      `Scam-raid detection and moderation status. [Source](${SOURCE_URL})`,
    )
    .addFields(
      {
        name: 'Deployment',
        value: [
          `Version: **v${info.version}**`,
          `Uptime: <t:${startedAt}:R>`,
          `Discord latency: **${info.discordLatencyMs} ms**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Coverage',
        value: [
          `Servers: **${info.guildCount.toLocaleString()}**`,
          `Monitored channels: **${info.monitoredChannelCount.toLocaleString()}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Corpus',
        value: [
          `Images: **${info.corpus.images.toLocaleString()}**`,
          `Text samples: **${info.corpus.texts.toLocaleString()}**`,
          `Health: **${corpusHealthy ? 'Ready' : `${info.corpus.missingEmbeddings} awaiting embeddings`}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Cases',
        value: [
          `Last 24 hours: **${info.cases.last24Hours.toLocaleString()}**`,
          `Last 7 days: **${info.cases.last7Days.toLocaleString()}**`,
          `Retained: **${info.cases.retained.toLocaleString()}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'AI analysis',
        value: [
          `Status: **${modelsReady ? 'Ready' : 'Configuration incomplete'}**`,
          ...classifiers.map(
            ({ purpose, provider, modelId }) =>
              `${purpose === 'text_classifier' ? 'Text' : 'Images'}: \`${provider}/${modelId ?? 'not configured'}\``,
          ),
        ].join('\n'),
        inline: false,
      },
      {
        name: 'System health',
        value: [
          'Database: **Connected**',
          `Corpus: **${corpusHealthy ? 'Ready' : 'Needs attention'}**`,
          `AI models: **${modelsReady ? 'Ready' : 'Needs configuration'}**`,
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: SOURCE_URL });

  if (showDiagnostics) {
    const diagnostics = info.diagnostics;
    embed.addFields({
      name: 'Manager diagnostics',
      value: [
        `Revision: \`${shortRevision(info.revision)}\``,
        'Database: **Connected**',
        `Model queue: **${diagnostics.modelQueue.active} active, ${diagnostics.modelQueue.queued} queued**`,
        `Moderation queue: **${diagnostics.moderationQueue.active} active, ${diagnostics.moderationQueue.queued} queued**`,
        `Failed analyses (24h): **${diagnostics.failedAnalysesLast24Hours}**`,
        `Last corpus update: ${diagnostics.lastCorpusUpdate ? `<t:${Math.floor(diagnostics.lastCorpusUpdate.getTime() / 1_000)}:R>` : '**Never**'}`,
        `Memory: **${formatBytes(diagnostics.memoryRssBytes)}**`,
      ].join('\n'),
      inline: false,
    });
  }

  return { embeds: [embed], ephemeral: showDiagnostics } as const;
}

function shortRevision(revision: string | null) {
  return revision ? revision.slice(0, 12) : 'unknown';
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024).toLocaleString()} MiB`;
}
