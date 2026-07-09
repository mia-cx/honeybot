import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type MentionableSelectMenuInteraction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type { ConfigStore } from '../services/configStore.js';
import { formatPolicy } from '../services/configStore.js';
import type { ModelStore } from '../services/modelStore.js';
import type { CaseOperation, CaseStore } from '../services/caseStore.js';
import {
  canActOnCases,
  canConfigureHoneybot,
  hasGlobalAuthority,
} from '../services/auth.js';
import { renderCrosschannelCurveImage } from '../services/crosschannelGraph.js';
import { parseDurationSeconds } from '../services/duration.js';
import { toggleVerboseLogging } from '../services/verbose.js';
import type {
  GuildConfig,
  Policy,
  PolicyScope,
  ModelPurpose,
} from '../domain/types.js';
import type { Db } from '../db/database.js';
import {
  applyPolicyForUser,
  dmPunishedUser,
  honeybotAuditReason,
  moderationAuditReason,
  revertPolicyForUser,
} from '../services/moderation.js';
import type { FairQueue } from '../queues/fairQueue.js';
import type { FileStorage } from '../storage/fileStorage.js';
import { globalBans } from '../db/schema.js';
import { randomUUID } from 'node:crypto';
import {
  honeypotWarningModal,
  honeypotWarningPublicMessage,
  honeypotWarningSentReply,
  modelApiKeyModal,
  modelConfigModal,
  pageForPolicyScope,
  pageFromValue,
  parseEditableSettingValue,
  policyDurationModal,
  policyScopeFromValue,
  settingEditModal,
  settingInputValue,
  settingsReply,
  settingsUpdate,
  type EditableSetting,
  type SettingsAdditionalSignalConfig,
  type SettingsModelConfig,
  type SettingsPage,
} from '../interactions/settingsUi.js';
import {
  caseReviewResolutionUpdate,
  caseReviewRevertUpdate,
} from '../interactions/caseReviewUi.js';
import type { GuildSettings } from '../domain/types.js';

const COMPONENTS_V2 = 1 << 15;
const EPHEMERAL = 1 << 6;

type RawComponent = { type: number; [key: string]: unknown };

const MARK_CASE_KNOWN_SCAM_COMMAND = 'Mark case as known scam';
const BAN_TRANSGRESSOR_GLOBALLY_COMMAND = 'Ban transgressor globally';

const legacyHoneybotTeamContextCommands = new Set([
  'Honeybot: global ban case',
  'Honeybot: add known scam',
]);

const honeybotTeamContextCommands = new Set([
  MARK_CASE_KNOWN_SCAM_COMMAND,
  BAN_TRANSGRESSOR_GLOBALLY_COMMAND,
  ...legacyHoneybotTeamContextCommands,
]);

type GlobalActionInteraction =
  | ChatInputCommandInteraction<'cached'>
  | MessageContextMenuCommandInteraction<'cached'>;

const modelPurposes = [
  'text_classifier',
  'image_classifier',
  'text_embeddings',
  'image_embeddings',
] as const satisfies readonly ModelPurpose[];

export type InteractionDependencies = {
  configStore: ConfigStore;
  modelStore: ModelStore;
  caseStore: CaseStore;
  db: Db;
  moderationQueue: FairQueue;
  storage: FileStorage;
  additionalSignalModels?: SettingsAdditionalSignalConfig;
};

async function settingsReplyForGuild(
  deps: InteractionDependencies,
  guildId: string,
  page: SettingsPage = 'none',
  policyScope: PolicyScope = 'punishment',
) {
  const [config, models] = await Promise.all([
    deps.configStore.getGuildConfig(guildId),
    settingsModelConfigs(deps, guildId),
  ]);
  return settingsReply(
    config,
    page,
    policyScope,
    models,
    deps.additionalSignalModels,
    await settingsCurveImage(config, page),
  );
}

async function settingsUpdateForGuild(
  deps: InteractionDependencies,
  guildId: string,
  page: SettingsPage,
  policyScope: PolicyScope = 'punishment',
) {
  const [config, models] = await Promise.all([
    deps.configStore.getGuildConfig(guildId),
    settingsModelConfigs(deps, guildId),
  ]);
  return settingsUpdate(
    config,
    page,
    policyScope,
    models,
    deps.additionalSignalModels,
    await settingsCurveImage(config, page),
  );
}

async function settingsCurveImage(config: GuildConfig, page: SettingsPage) {
  return page === 'triggers_crosschannel'
    ? renderCrosschannelCurveImage(config)
    : undefined;
}

async function settingsModelConfigs(
  deps: InteractionDependencies,
  guildId: string,
): Promise<SettingsModelConfig[]> {
  return Promise.all(
    modelPurposes.map(async (purpose) => {
      const model = await deps.modelStore.get(guildId, purpose);
      return {
        purpose,
        provider: model.provider,
        modelId: model.modelId,
        apiKeyHint: model.apiKeyHint,
      };
    }),
  );
}

export async function handleInteractionCreate(
  interaction: Interaction,
  deps: InteractionDependencies,
) {
  if (!interaction.inCachedGuild()) return;

  if (interaction.isChatInputCommand()) {
    if (!(await canUseCommand(interaction, deps))) {
      const restrictedToGlobalAdmins =
        interaction.commandName === 'admin' ||
        interaction.commandName === 'honeybot-team' ||
        (interaction.commandName === 'global-bans' &&
          interaction.options.getSubcommand(false) === 'publish');
      await interaction.reply({
        content: restrictedToGlobalAdmins
          ? 'Nope. Honeybot global admin access required.'
          : 'Nope. Honeybot management is restricted to server managers/moderators.',
        ephemeral: true,
      });
      return;
    }
    await handleCommand(interaction, deps);
    return;
  }

  if (
    interaction.isMessageContextMenuCommand() &&
    honeybotTeamContextCommands.has(interaction.commandName)
  ) {
    if (!(await hasGlobalAuthority(interaction))) {
      await interaction.reply({
        content: 'Nope. Honeybot global admin access required.',
        ephemeral: true,
      });
      return;
    }
    await handleHoneybotTeamContextMenu(interaction, deps);
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith('admin:corpus:')) {
      if (!(await hasGlobalAuthority(interaction))) {
        await interaction.reply({
          content: 'Nope. Honeybot global admin access required.',
          ephemeral: true,
        });
        return;
      }
      await handleKnownCorpusButton(interaction, deps);
      return;
    }
    if (interaction.customId.startsWith('settings:')) {
      if (!(await canConfigureHoneybot(interaction, deps.configStore))) {
        await interaction.reply({
          content:
            'Nope. Honeybot configuration is restricted to server managers/configurators.',
          ephemeral: true,
        });
        return;
      }
      await handleSettingsButton(interaction, deps);
    } else {
      if (!(await canActOnCases(interaction, deps.configStore))) {
        await interaction.reply({
          content: 'Nope. Case actions are moderator-only.',
          ephemeral: true,
        });
        return;
      }
      await handleCaseButton(interaction, deps);
    }
    return;
  }

  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith('settings:')
  ) {
    if (!(await canConfigureHoneybot(interaction, deps.configStore))) {
      await interaction.reply({ content: 'Nope.', ephemeral: true });
      return;
    }
    await handleSettingsStringSelect(interaction, deps);
    return;
  }

  if (
    interaction.isChannelSelectMenu() &&
    (interaction.customId.startsWith('settings:channel:') ||
      interaction.customId.startsWith('settings:channels:'))
  ) {
    if (!(await canConfigureHoneybot(interaction, deps.configStore))) {
      await interaction.reply({ content: 'Nope.', ephemeral: true });
      return;
    }
    await handleSettingsChannelSelect(interaction, deps);
    return;
  }

  if (
    interaction.isMentionableSelectMenu() &&
    interaction.customId.startsWith('settings:mentionables:')
  ) {
    if (!(await canConfigureHoneybot(interaction, deps.configStore))) {
      await interaction.reply({ content: 'Nope.', ephemeral: true });
      return;
    }
    await handleSettingsMentionableSelect(interaction, deps);
    return;
  }

  if (
    interaction.isUserSelectMenu() &&
    interaction.customId.startsWith('settings:users:')
  ) {
    if (!(await canConfigureHoneybot(interaction, deps.configStore))) {
      await interaction.reply({ content: 'Nope.', ephemeral: true });
      return;
    }
    await handleSettingsUserSelect(interaction, deps);
    return;
  }

  if (
    interaction.isRoleSelectMenu() &&
    interaction.customId.startsWith('settings:roles:')
  ) {
    if (!(await canConfigureHoneybot(interaction, deps.configStore))) {
      await interaction.reply({ content: 'Nope.', ephemeral: true });
      return;
    }
    await handleSettingsRoleSelect(interaction, deps);
    return;
  }

  if (
    interaction.isRoleSelectMenu() &&
    interaction.customId.startsWith('settings:policyRole:')
  ) {
    if (!(await canConfigureHoneybot(interaction, deps.configStore))) {
      await interaction.reply({ content: 'Nope.', ephemeral: true });
      return;
    }
    await handleSettingsPolicyRoleSelect(interaction, deps);
    return;
  }

  if (
    interaction.isModalSubmit() &&
    (interaction.customId.startsWith('settings:modal:') ||
      interaction.customId.startsWith('settings:policyModal:') ||
      interaction.customId.startsWith('settings:modelModal:') ||
      interaction.customId.startsWith('settings:modelKeyModal:') ||
      interaction.customId === 'settings:honeypotWarningModal')
  ) {
    if (!(await canConfigureHoneybot(interaction, deps.configStore))) {
      await interaction.reply({ content: 'Nope.', ephemeral: true });
      return;
    }
    await handleSettingsModal(interaction, deps);
    return;
  }

  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith('model:key:')
  ) {
    if (!(await canConfigureHoneybot(interaction, deps.configStore))) {
      await interaction.reply({ content: 'Nope.', ephemeral: true });
      return;
    }
    const purpose = interaction.customId.split(':')[2] as
      ModelPurpose | undefined;
    const key = interaction.fields.getTextInputValue('api_key');
    if (!purpose) throw new Error('Missing model purpose');
    await deps.modelStore.setApiKey(interaction.guildId, purpose, key);
    await interaction.reply({
      content: `Stored API key for ${purpose}.`,
      ephemeral: true,
    });
  }
}

async function canUseCommand(
  interaction: ChatInputCommandInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  if (
    interaction.commandName === 'admin' ||
    interaction.commandName === 'honeybot-team' ||
    (interaction.commandName === 'global-bans' &&
      interaction.options.getSubcommand(false) === 'publish')
  ) {
    return hasGlobalAuthority(interaction);
  }
  return canConfigureHoneybot(interaction, deps.configStore);
}

async function handleCommand(
  interaction: ChatInputCommandInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  switch (interaction.commandName) {
    case 'settings': {
      await interaction.reply(
        await settingsReplyForGuild(deps, interaction.guildId),
      );
      return;
    }
    case 'honeypot': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add' || sub === 'remove') {
        const channel = interaction.options.getChannel('channel', true);
        if (sub === 'add')
          await deps.configStore.addHoneypot(interaction.guildId, channel.id);
        else
          await deps.configStore.removeHoneypot(
            interaction.guildId,
            channel.id,
          );
        await interaction.reply({
          content: `${sub === 'add' ? 'Added' : 'Removed'} <#${channel.id}>.`,
          ephemeral: true,
        });
        return;
      }
      const config = await deps.configStore.getGuildConfig(interaction.guildId);
      await interaction.reply({
        content:
          config.honeypotChannelIds.map((id) => `<#${id}>`).join('\n') ||
          'No honeypots configured.',
        ephemeral: true,
      });
      return;
    }
    case 'moderators': {
      const sub = interaction.options.getSubcommand();
      if (sub.includes('user')) {
        const user = interaction.options.getUser('user', true);
        if (sub.startsWith('add'))
          await deps.configStore.addModerator(
            interaction.guildId,
            'user',
            user.id,
          );
        else
          await deps.configStore.removeModerator(
            interaction.guildId,
            'user',
            user.id,
          );
        await interaction.reply({
          content: `${sub.startsWith('add') ? 'Added' : 'Removed'} <@${user.id}>.`,
          ephemeral: true,
        });
        return;
      }
      if (sub.includes('role')) {
        const role = interaction.options.getRole('role', true);
        if (sub.startsWith('add'))
          await deps.configStore.addModerator(
            interaction.guildId,
            'role',
            role.id,
          );
        else
          await deps.configStore.removeModerator(
            interaction.guildId,
            'role',
            role.id,
          );
        await interaction.reply({
          content: `${sub.startsWith('add') ? 'Added' : 'Removed'} <@&${role.id}>.`,
          ephemeral: true,
        });
        return;
      }
      const config = await deps.configStore.getGuildConfig(interaction.guildId);
      await interaction.reply({
        content: [
          `Users: ${config.moderatorUsers.map((id) => `<@${id}>`).join(', ') || 'none'}`,
          `Roles: ${config.moderatorRoles.map((id) => `<@&${id}>`).join(', ') || 'none'}`,
        ].join('\n'),
        ephemeral: true,
      });
      return;
    }
    case 'policies': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'set') {
        const policy: Policy = {
          scope: interaction.options.getString('scope', true) as PolicyScope,
          actionType: interaction.options.getString(
            'action',
            true,
          ) as Policy['actionType'],
          durationSeconds: interaction.options.getInteger('duration'),
          roleId: interaction.options.getRole('role')?.id ?? null,
          deleteMessages:
            interaction.options.getBoolean('delete_messages') ?? true,
        };
        await deps.configStore.setPolicy(interaction.guildId, policy);
        await interaction.reply({
          content: `Policy set: ${policy.scope} = ${formatPolicy(policy)}`,
          ephemeral: true,
        });
        return;
      }
      const config = await deps.configStore.getGuildConfig(interaction.guildId);
      await interaction.reply({
        content: code(
          Object.values(config.policies)
            .map((policy) => `${policy.scope}: ${formatPolicy(policy)}`)
            .join('\n'),
        ),
        ephemeral: true,
      });
      return;
    }
    case 'model': {
      await handleModelCommand(interaction, deps);
      return;
    }
    case 'admin':
    case 'honeybot-team': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'corpus' || sub === 'known-corpus') {
        await replyWithKnownCorpus(interaction, deps, {
          type: corpusTypeFromValue(interaction.options.getString('type')),
          page: interaction.options.getInteger('page') ?? 1,
        });
        return;
      }
      if (sub === 'verbose') {
        const enabled = await toggleVerboseLogging(deps.db);
        await interaction.reply({
          content: `Honeybot verbose model logging is now ${enabled ? 'enabled' : 'disabled'}.`,
          ephemeral: true,
        });
        return;
      }
      const caseId = interaction.options.getString('case_id', true);
      if (sub === 'add') {
        const addType = interaction.options.getString('type', true);
        if (addType === 'ban')
          await publishGlobalBanFromCase(interaction, deps, caseId);
        else if (addType === 'scam')
          await promoteCaseToGlobalKnownScams(interaction, deps, caseId);
        else
          await interaction.reply({
            content: 'Unknown admin add type.',
            ephemeral: true,
          });
        return;
      }
      if (sub === 'global-ban') {
        await publishGlobalBanFromCase(interaction, deps, caseId);
        return;
      }
      if (sub === 'known-scam') {
        await promoteCaseToGlobalKnownScams(interaction, deps, caseId);
        return;
      }
      await interaction.reply({
        content: 'Unknown Honeybot admin action.',
        ephemeral: true,
      });
      return;
    }
    case 'global-bans': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'publish') {
        await publishGlobalBanFromCase(
          interaction,
          deps,
          interaction.options.getString('case_id', true),
        );
        return;
      }
      if (sub === 'opt-in')
        await deps.configStore.setSetting(
          interaction.guildId,
          'globalBansEnabled',
          true,
        );
      if (sub === 'opt-out')
        await deps.configStore.setSetting(
          interaction.guildId,
          'globalBansEnabled',
          false,
        );
      const config = await deps.configStore.getGuildConfig(interaction.guildId);
      await interaction.reply({
        content: `Global bans: ${config.globalBansEnabled ? 'enabled' : 'disabled'}`,
        ephemeral: true,
      });
      return;
    }
  }
}

type CorpusType = 'all' | 'text' | 'image';

async function replyWithKnownCorpus(
  interaction: ChatInputCommandInteraction<'cached'>,
  deps: InteractionDependencies,
  input: { type: CorpusType; page: number },
) {
  await interaction.reply({
    flags: COMPONENTS_V2 | EPHEMERAL,
    components: await knownCorpusComponents(deps, interaction.guildId, input),
  });
}

async function handleKnownCorpusButton(
  interaction: ButtonInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const [, , , typeValue, pageValue] = interaction.customId.split(':');
  await interaction.update({
    components: await knownCorpusComponents(deps, interaction.guildId, {
      type: corpusTypeFromValue(typeValue),
      page: Number.parseInt(pageValue ?? '1', 10) || 1,
    }),
  });
}

async function knownCorpusComponents(
  deps: InteractionDependencies,
  guildId: string,
  input: { type: CorpusType; page: number },
) {
  const page = await deps.caseStore.listKnownCorpus(guildId, {
    type: input.type,
    page: input.page,
  });
  const entries = page.items.map((item, index) => {
    const number = (page.page - 1) * page.pageSize + index + 1;
    const embedding = item.embeddingModel
      ? `${item.embeddingProvider}/${item.embeddingModel}${item.embeddingDimensions ? ` (${item.embeddingDimensions}d)` : ''}`
      : 'no embedding';
    const scope =
      item.scope === 'guild' && item.guildId
        ? `guild:${item.guildId}`
        : item.scope;
    return text(
      [
        `### ${number}. ${item.kind.toUpperCase()} \`${item.id}\``,
        `-# Scope: ${scope} • Embedding: ${embedding}`,
        `**Reason:** ${truncateDiscord(item.scamReason, 180)}`,
        `**Preview:** ${truncateDiscord(item.preview, 220)}`,
      ].join('\n'),
    );
  });

  return [
    container([
      text(
        [
          '# Known scam corpus',
          `-# Showing ${page.type} entries — page ${page.page}/${page.totalPages} (${page.total} total).`,
        ].join('\n'),
      ),
      separator(),
      ...(entries.length > 0
        ? entries
        : [text('No approved corpus entries found.')]),
    ]),
    buttonRow([
      button(
        `admin:corpus:prev:${page.type}:${Math.max(1, page.page - 1)}`,
        'Previous',
        2,
        page.page <= 1,
      ),
      button(
        `admin:corpus:next:${page.type}:${Math.min(page.totalPages, page.page + 1)}`,
        'Next',
        2,
        page.page >= page.totalPages,
      ),
    ]),
  ];
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

function buttonRow(components: RawComponent[]): RawComponent {
  return { type: 1, components };
}

function button(
  customId: string,
  label: string,
  style: 1 | 2 | 3 | 4,
  disabled = false,
): RawComponent {
  return { type: 2, custom_id: customId, label, style, disabled };
}

function corpusTypeFromValue(value: string | null | undefined): CorpusType {
  return value === 'text' || value === 'image' ? value : 'all';
}

function truncateDiscord(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function publishGlobalBanFromCase(
  interaction: GlobalActionInteraction,
  deps: InteractionDependencies,
  caseId: string,
) {
  const caseRow = await deps.caseStore.getCase(caseId);
  if (!caseRow) {
    await interaction.reply({
      content:
        'Case not found. Global bans can only be published from retained case data.',
      ephemeral: true,
    });
    return;
  }

  const now = new Date().toISOString();
  const reason = caseRow.reason ?? 'Published from Honeybot case';
  await deps.db.insert(globalBans).values({
    id: randomUUID(),
    userId: caseRow.userId,
    sourceCaseId: caseId,
    publishedByUserId: interaction.user.id,
    status: 'active',
    reason,
    createdAt: now,
    updatedAt: now,
  });

  let swept = 0;
  for (const guild of interaction.client.guilds.cache.values()) {
    const config = await deps.configStore.getGuildConfig(guild.id);
    if (!config.globalBansEnabled) continue;
    const member = await guild.members.fetch(caseRow.userId).catch(() => null);
    if (!member) continue;
    await deps.moderationQueue.enqueue(guild.id, () =>
      guild.members.ban(caseRow.userId, {
        reason: moderationAuditReason(
          {
            scope: 'punishment',
            actionType: 'ban',
            durationSeconds: null,
            roleId: null,
            deleteMessages: false,
          },
          honeybotAuditReason({
            caseId,
            triggerType: caseRow.triggerType,
            decisionSource: 'global-ban',
            confidence: caseConfidence(caseRow.evidenceSummaryJson),
            actorId: interaction.user.id,
          }),
        ),
      }),
    );
    swept += 1;
  }

  await interaction.reply({
    content: `Published global ban for <@${caseRow.userId}> from case \`${caseId}\`. Swept ${swept} opted-in guild(s).`,
    ephemeral: true,
  });
}

async function promoteCaseToGlobalKnownScams(
  interaction: GlobalActionInteraction,
  deps: InteractionDependencies,
  caseId: string,
) {
  const result = await deps.caseStore.promoteCaseToGlobalKnownScams(
    caseId,
    interaction.user.id,
  );
  if (!result) {
    await interaction.reply({
      content:
        'Case not found. Known scams can only be promoted from retained case data.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: [
      `Promoted case \`${caseId}\` to global known scams.`,
      `Text added: ${result.textAdded} (${result.textSkipped} skipped)`,
      `Images added: ${result.imageAdded} (${result.imageSkipped} skipped)`,
    ].join('\n'),
    ephemeral: true,
  });
}

async function handleHoneybotTeamContextMenu(
  interaction: MessageContextMenuCommandInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const caseRow =
    (await deps.caseStore.getCaseByReviewMessage(
      interaction.guildId,
      interaction.targetMessage.id,
    )) ??
    (await deps.caseStore.getCaseBySourceMessage(interaction.targetMessage.id));
  if (!caseRow) {
    await interaction.reply({
      content: 'That message is not linked to a retained Honeybot case.',
      ephemeral: true,
    });
    return;
  }

  if (
    interaction.commandName === MARK_CASE_KNOWN_SCAM_COMMAND ||
    interaction.commandName === 'Honeybot: add known scam'
  ) {
    await promoteCaseToGlobalKnownScams(interaction, deps, caseRow.id);
    return;
  }

  if (
    interaction.commandName === BAN_TRANSGRESSOR_GLOBALLY_COMMAND ||
    interaction.commandName === 'Honeybot: global ban case'
  ) {
    await publishGlobalBanFromCase(interaction, deps, caseRow.id);
    return;
  }

  await interaction.reply({
    content: 'Unknown Honeybot team context action.',
    ephemeral: true,
  });
}

async function handleSettingsStringSelect(
  interaction: StringSelectMenuInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  if (
    interaction.customId === 'settings:page' ||
    interaction.customId.startsWith('settings:subcategory:')
  ) {
    const page = pageFromValue(interaction.values[0]);
    await interaction.update(
      await settingsUpdateForGuild(deps, interaction.guildId, page),
    );
    return;
  }

  if (interaction.customId === 'settings:honeypotWarningChannel') {
    await sendHoneypotWarning(interaction, deps, interaction.values[0]);
    return;
  }

  if (interaction.customId === 'settings:policyScope') {
    const scope = policyScopeFromValue(interaction.values[0]);
    await interaction.update(
      await settingsUpdateForGuild(
        deps,
        interaction.guildId,
        pageForPolicyScope(scope),
        scope,
      ),
    );
    return;
  }

  if (interaction.customId.startsWith('settings:policyAction:')) {
    const scope = policyScopeFromValue(interaction.customId.split(':')[2]);
    const config = await deps.configStore.getGuildConfig(interaction.guildId);
    const actionType = interaction.values[0] as
      Policy['actionType'] | undefined;
    if (!actionType || (scope === 'punishment' && actionType === 'log')) {
      await interaction.reply({
        content: 'Invalid policy action.',
        ephemeral: true,
      });
      return;
    }
    await deps.configStore.setPolicy(interaction.guildId, {
      ...config.policies[scope],
      actionType,
    });
    await interaction.update(
      await settingsUpdateForGuild(
        deps,
        interaction.guildId,
        pageForPolicyScope(scope),
        scope,
      ),
    );
    return;
  }

  await interaction.reply({
    content: 'Unknown settings select.',
    ephemeral: true,
  });
}

async function sendHoneypotWarning(
  interaction:
    ModalSubmitInteraction<'cached'> | StringSelectMenuInteraction<'cached'>,
  deps: InteractionDependencies,
  channelId: string | undefined,
) {
  const config = await deps.configStore.getGuildConfig(interaction.guildId);
  if (!channelId || !config.honeypotChannelIds.includes(channelId)) {
    await interaction.reply({
      content: 'That channel is not configured as a honeypot.',
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    await interaction.reply({
      content: 'Honeybot could not find that honeypot text channel.',
      ephemeral: true,
    });
    return;
  }

  await channel.send(honeypotWarningPublicMessage(config));
  if (interaction.isStringSelectMenu()) {
    await interaction.update({ components: [] });
    return;
  }
  await interaction.reply(honeypotWarningSentReply(channelId));
}

async function handleSettingsButton(
  interaction: ButtonInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const [, action, key, pageValue] = interaction.customId.split(':');
  const page = pageFromValue(pageValue);
  const config = await deps.configStore.getGuildConfig(interaction.guildId);

  if (action === 'page') {
    await interaction.update(
      await settingsUpdateForGuild(
        deps,
        interaction.guildId,
        pageFromValue(key),
      ),
    );
    return;
  }

  if (action === 'honeypotWarning') {
    const channels = config.honeypotChannelIds.flatMap((channelId) => {
      const channel = interaction.guild.channels.cache.get(channelId);
      if (!channel) return [];
      return [
        { id: channel.id, name: 'name' in channel ? channel.name : channelId },
      ];
    });
    const modal = honeypotWarningModal(channels);
    if (!modal) {
      await interaction.reply({
        content: 'No honeypot channels are configured yet.',
        ephemeral: true,
      });
      return;
    }
    await interaction.showModal(modal);
    return;
  }

  if (action === 'modelEdit' && isModelPurpose(key)) {
    const current = (
      await settingsModelConfigs(deps, interaction.guildId)
    ).find((model) => model.purpose === key);
    await interaction.showModal(modelConfigModal(key, current));
    return;
  }

  if (action === 'modelKey' && isModelPurpose(key)) {
    await interaction.showModal(modelApiKeyModal(key));
    return;
  }

  if (action === 'modelClearKey' && isModelPurpose(key)) {
    await deps.modelStore.clearApiKey(interaction.guildId, key);
    await interaction.update(
      await settingsUpdateForGuild(deps, interaction.guildId, page),
    );
    return;
  }

  if (action === 'toggle' && isBooleanSetting(key)) {
    await deps.configStore.setSetting(interaction.guildId, key, !config[key]);
    await interaction.update(
      await settingsUpdateForGuild(deps, interaction.guildId, page),
    );
    return;
  }

  if (action === 'edit' && isEditableSetting(key)) {
    await interaction.showModal(
      settingEditModal(key, settingInputValue(config, key), page),
    );
    return;
  }

  if (action === 'clear') {
    await clearSettingTarget(interaction, deps, key, page);
    return;
  }

  if (action === 'policyDuration') {
    const scope = policyScopeFromValue(key);
    await interaction.showModal(
      policyDurationModal(scope, config.policies[scope].durationSeconds),
    );
    return;
  }

  if (action === 'policyDelete') {
    const scope = policyScopeFromValue(key);
    const policy = config.policies[scope];
    await deps.configStore.setPolicy(interaction.guildId, {
      ...policy,
      deleteMessages: !policy.deleteMessages,
    });
    await interaction.update(
      await settingsUpdateForGuild(
        deps,
        interaction.guildId,
        pageForPolicyScope(scope),
        scope,
      ),
    );
    return;
  }

  if (action === 'policyClearRole') {
    const scope = policyScopeFromValue(key);
    await deps.configStore.setPolicy(interaction.guildId, {
      ...config.policies[scope],
      roleId: null,
    });
    await interaction.update(
      await settingsUpdateForGuild(
        deps,
        interaction.guildId,
        pageForPolicyScope(scope),
        scope,
      ),
    );
    return;
  }

  await interaction.reply({
    content: 'Unknown settings action.',
    ephemeral: true,
  });
}

async function handleSettingsChannelSelect(
  interaction: ChannelSelectMenuInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const [, kind, key, pageValue] = interaction.customId.split(':');
  const page = pageFromValue(pageValue);

  if (kind === 'channel' && key === 'moderationChannelId') {
    await deps.configStore.setSetting(
      interaction.guildId,
      'moderationChannelId',
      interaction.values[0] ?? null,
    );
    await interaction.update(
      await settingsUpdateForGuild(deps, interaction.guildId, page),
    );
    return;
  }

  if (kind === 'channels' && key === 'honeypots') {
    await deps.configStore.setHoneypots(
      interaction.guildId,
      interaction.values,
    );
    await interaction.update(
      await settingsUpdateForGuild(deps, interaction.guildId, page),
    );
    return;
  }

  await interaction.reply({
    content: 'Unknown channel setting.',
    ephemeral: true,
  });
}

async function handleSettingsMentionableSelect(
  interaction: MentionableSelectMenuInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const [, , key, pageValue] = interaction.customId.split(':');
  if (key === 'moderators') {
    await deps.configStore.setModerators(interaction.guildId, 'user', [
      ...interaction.users.keys(),
    ]);
    await deps.configStore.setModerators(interaction.guildId, 'role', [
      ...interaction.roles.keys(),
    ]);
  } else if (key === 'configManagers') {
    await deps.configStore.setConfigManagers(
      interaction.guildId,
      'config_user',
      [...interaction.users.keys()],
    );
    await deps.configStore.setConfigManagers(
      interaction.guildId,
      'config_role',
      [...interaction.roles.keys()],
    );
  } else {
    await interaction.reply({
      content: 'Unknown mentionable setting.',
      ephemeral: true,
    });
    return;
  }
  await interaction.update(
    await settingsUpdateForGuild(
      deps,
      interaction.guildId,
      pageFromValue(pageValue),
    ),
  );
}

async function handleSettingsUserSelect(
  interaction: UserSelectMenuInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const [, , key, pageValue] = interaction.customId.split(':');
  if (key !== 'moderatorUsers') {
    await interaction.reply({
      content: 'Unknown user setting.',
      ephemeral: true,
    });
    return;
  }
  await deps.configStore.setModerators(
    interaction.guildId,
    'user',
    interaction.values,
  );
  await interaction.update(
    await settingsUpdateForGuild(
      deps,
      interaction.guildId,
      pageFromValue(pageValue),
    ),
  );
}

async function handleSettingsRoleSelect(
  interaction: RoleSelectMenuInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const [, , key, pageValue] = interaction.customId.split(':');
  if (key !== 'moderatorRoles') {
    await interaction.reply({
      content: 'Unknown role setting.',
      ephemeral: true,
    });
    return;
  }
  await deps.configStore.setModerators(
    interaction.guildId,
    'role',
    interaction.values,
  );
  await interaction.update(
    await settingsUpdateForGuild(
      deps,
      interaction.guildId,
      pageFromValue(pageValue),
    ),
  );
}

async function handleSettingsPolicyRoleSelect(
  interaction: RoleSelectMenuInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const scope = policyScopeFromValue(interaction.customId.split(':')[2]);
  const config = await deps.configStore.getGuildConfig(interaction.guildId);
  await deps.configStore.setPolicy(interaction.guildId, {
    ...config.policies[scope],
    roleId: interaction.values[0] ?? null,
  });
  await interaction.update(
    await settingsUpdateForGuild(
      deps,
      interaction.guildId,
      pageForPolicyScope(scope),
      scope,
    ),
  );
}

async function handleSettingsModal(
  interaction: ModalSubmitInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  if (interaction.customId === 'settings:honeypotWarningModal') {
    await sendHoneypotWarning(
      interaction,
      deps,
      interaction.fields.getStringSelectValues(
        'settings:honeypotWarningChannel',
      )[0],
    );
    return;
  }

  if (interaction.customId.startsWith('settings:modelModal:')) {
    const purpose = interaction.customId.split(':')[2];
    if (!isModelPurpose(purpose)) {
      await interaction.reply({
        content: 'Unknown model purpose.',
        ephemeral: true,
      });
      return;
    }
    const provider = interaction.fields.getTextInputValue('provider').trim();
    const modelId = isEmbeddingPurpose(purpose)
      ? null
      : interaction.fields.getTextInputValue('model_id').trim() || null;
    if (!provider) {
      await interaction.reply({
        content: 'Provider is required.',
        ephemeral: true,
      });
      return;
    }
    await deps.modelStore.setModel(
      interaction.guildId,
      purpose,
      provider,
      modelId,
    );
    await interaction.reply(
      await settingsReplyForGuild(
        deps,
        interaction.guildId,
        modelPageForPurpose(purpose),
      ),
    );
    return;
  }

  if (interaction.customId.startsWith('settings:modelKeyModal:')) {
    const purpose = interaction.customId.split(':')[2];
    if (!isModelPurpose(purpose)) {
      await interaction.reply({
        content: 'Unknown model purpose.',
        ephemeral: true,
      });
      return;
    }
    await deps.modelStore.setApiKey(
      interaction.guildId,
      purpose,
      interaction.fields.getTextInputValue('api_key'),
    );
    await interaction.reply(
      await settingsReplyForGuild(
        deps,
        interaction.guildId,
        modelPageForPurpose(purpose),
      ),
    );
    return;
  }

  if (interaction.customId.startsWith('settings:policyModal:')) {
    const [, , field, scopeValue] = interaction.customId.split(':');
    const scope = policyScopeFromValue(scopeValue);
    if (field !== 'duration') {
      await interaction.reply({
        content: 'Unknown policy field.',
        ephemeral: true,
      });
      return;
    }
    const raw = interaction.fields.getTextInputValue('value').trim();
    const durationSeconds = parseDurationSeconds(raw);
    if (raw !== '' && durationSeconds === null) {
      await interaction.reply({
        content:
          'Please enter a duration like `21600`, `6h`, `4d12h`, `90m`, `01:30:00`, or `PT6H`; or leave blank.',
        ephemeral: true,
      });
      return;
    }
    const config = await deps.configStore.getGuildConfig(interaction.guildId);
    await deps.configStore.setPolicy(interaction.guildId, {
      ...config.policies[scope],
      durationSeconds,
    });
    await interaction.reply(
      await settingsReplyForGuild(
        deps,
        interaction.guildId,
        pageForPolicyScope(scope),
        scope,
      ),
    );
    return;
  }

  const [, , key, pageValue] = interaction.customId.split(':');
  if (!isEditableSetting(key)) {
    await interaction.reply({ content: 'Unknown setting.', ephemeral: true });
    return;
  }

  const value = parseEditableSettingValue(
    key,
    interaction.fields.getTextInputValue('value'),
  );
  if (value === null) {
    await interaction.reply({
      content:
        'Please enter a valid non-negative value. Percent settings use 0-100.',
      ephemeral: true,
    });
    return;
  }

  await deps.configStore.setSetting(interaction.guildId, key, value);
  await interaction.reply(
    await settingsReplyForGuild(
      deps,
      interaction.guildId,
      pageFromValue(pageValue),
    ),
  );
}

async function clearSettingTarget(
  interaction: ButtonInteraction<'cached'>,
  deps: InteractionDependencies,
  target: string | undefined,
  page: ReturnType<typeof pageFromValue>,
) {
  switch (target) {
    case 'moderationChannelId':
      await deps.configStore.setSetting(
        interaction.guildId,
        'moderationChannelId',
        null,
      );
      break;
    case 'honeypots':
      await deps.configStore.setHoneypots(interaction.guildId, []);
      break;
    case 'moderators':
      await deps.configStore.setModerators(interaction.guildId, 'user', []);
      await deps.configStore.setModerators(interaction.guildId, 'role', []);
      break;
    case 'configManagers':
      await deps.configStore.setConfigManagers(
        interaction.guildId,
        'config_user',
        [],
      );
      await deps.configStore.setConfigManagers(
        interaction.guildId,
        'config_role',
        [],
      );
      break;
    case 'moderatorUsers':
      await deps.configStore.setModerators(interaction.guildId, 'user', []);
      break;
    case 'moderatorRoles':
      await deps.configStore.setModerators(interaction.guildId, 'role', []);
      break;
    default:
      await interaction.reply({
        content: 'Unknown clear action.',
        ephemeral: true,
      });
      return;
  }

  await interaction.update(
    await settingsUpdateForGuild(deps, interaction.guildId, page),
  );
}

async function handleModelCommand(
  interaction: ChatInputCommandInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'set') {
    const purpose = interaction.options.getString(
      'purpose',
      true,
    ) as ModelPurpose;
    const provider = interaction.options.getString('provider') ?? 'openrouter';
    const modelId = isEmbeddingPurpose(purpose)
      ? null
      : interaction.options.getString('model_id');
    await deps.modelStore.setModel(
      interaction.guildId,
      purpose,
      provider,
      modelId,
    );
    if (interaction.options.getBoolean('enter_api_key')) {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`model:key:${purpose}`)
          .setTitle(`API key for ${purpose}`)
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('api_key')
                .setLabel('API key')
                .setStyle(TextInputStyle.Short)
                .setRequired(true),
            ),
          ),
      );
      return;
    }
    await interaction.reply({
      content: `Model set for ${purpose}.`,
      ephemeral: true,
    });
    return;
  }
  if (sub === 'clear-key') {
    const purpose = interaction.options.getString(
      'purpose',
      true,
    ) as ModelPurpose;
    await deps.modelStore.clearApiKey(interaction.guildId, purpose);
    await interaction.reply({
      content: `Cleared key for ${purpose}.`,
      ephemeral: true,
    });
    return;
  }
  const rows = await deps.modelStore.list(interaction.guildId);
  await interaction.reply({
    content: code(
      rows
        .map(
          (row) =>
            `${row.purpose}: ${row.provider}/${row.modelId ?? 'default'} guild_byok=${row.apiKeyHint ?? 'not set'}`,
        )
        .join('\n') || 'No per-guild model overrides.',
    ),
    ephemeral: true,
  });
}

async function handleCaseButton(
  interaction: ButtonInteraction<'cached'>,
  deps: InteractionDependencies,
) {
  const [, action, caseId] = interaction.customId.split(':');
  if (!action || !caseId) return;

  const caseRow = await deps.caseStore.getCase(caseId);
  if (!caseRow) {
    await interaction.reply({
      content: 'Case is gone or already dismissed/reverted.',
      ephemeral: true,
    });
    return;
  }

  if (action === 'dismiss') {
    const config = await deps.configStore.getGuildConfig(interaction.guildId);
    const operation = await runCaseOperation(interaction, deps, {
      caseId,
      operation: 'dismiss',
      run: () =>
        deps.moderationQueue.enqueue(interaction.guildId, () =>
          revertPrevention(interaction, caseRow, config),
        ),
      completion: (revertResult) => ({
        actionTaken: null,
        reason: `Dismissed by moderator; prevention revert: ${revertResult}`,
      }),
    });
    if (!operation) return;
    const revertResult = operation.value;
    await deps.caseStore.addEvent(
      caseId,
      'prevention_reverted',
      'user',
      interaction.user.id,
      'Dismissed by moderator',
      { revertResult },
    );
    await interaction.update(
      caseReviewResolutionUpdate(interaction.message.components, {
        caseId,
        status: 'dismissed',
        actorId: interaction.user.id,
        userId: caseRow.userId,
        detail: revertResult,
        punishment: config.policies.punishment,
        canRevert: true,
      }),
    );
    return;
  }

  if (action === 'globalban') {
    await interaction.reply({
      content:
        'Global bans are published with `/admin add ban`, not case buttons.',
      ephemeral: true,
    });
    return;
  }

  const config = await deps.configStore.getGuildConfig(interaction.guildId);

  if (action === 'punish') {
    const policy = config.policies.punishment;
    const reason = caseRow.reason ?? 'Punished by Honeybot moderator review';
    const auditReason = honeybotAuditReason({
      caseId,
      triggerType: caseRow.triggerType,
      decisionSource: 'mod-approved',
      confidence: caseConfidence(caseRow.evidenceSummaryJson),
      actorId: interaction.user.id,
    });
    const operation = await runCaseOperation(interaction, deps, {
      caseId,
      operation: 'punish',
      run: async () => {
        const member = await interaction.guild.members
          .fetch(caseRow.userId)
          .catch(() => null);
        if (config.punishmentDmNotify && member) {
          await dmPunishedUser({
            member,
            caseId,
            action: policy.actionType,
            reason,
            auditReason,
            caseStore: deps.caseStore,
            storage: deps.storage,
          });
        }
        const applyResult = await deps.moderationQueue.enqueue(
          interaction.guildId,
          () =>
            applyPolicyForUser(
              interaction.guild,
              caseRow.userId,
              policy,
              auditReason,
            ),
        );
        return { applyResult, member };
      },
      completion: () => ({ actionTaken: policy.actionType, reason }),
    });
    if (!operation) return;
    const { applyResult, member } = operation.value;
    if (config.punishmentDmNotify && !member) {
      await deps.caseStore.addEvent(
        caseId,
        'failed',
        'bot',
        null,
        'Punishment DM failed',
        {
          error: 'Cannot DM user because they are no longer in the guild',
          omitted: [],
        },
      );
    }
    await deps.caseStore.addEvent(
      caseId,
      'punishment_applied',
      'user',
      interaction.user.id,
      reason,
      { applyResult },
    );
    await interaction.update(
      caseReviewResolutionUpdate(interaction.message.components, {
        caseId,
        status: 'punished',
        actorId: interaction.user.id,
        userId: caseRow.userId,
        detail: reason,
        punishment: policy,
        canRevert: true,
      }),
    );
    return;
  }

  if (action === 'revert') {
    if (caseRow.status === 'punished') {
      const operation = await runCaseOperation(interaction, deps, {
        caseId,
        operation: 'revert_punishment',
        run: () =>
          deps.moderationQueue.enqueue(interaction.guildId, () =>
            revertPolicyForUser(
              interaction.guild,
              caseRow.userId,
              config.policies.punishment,
              'Reverted Honeybot punishment action',
            ),
          ),
        completion: (revertResult) => ({
          actionTaken: null,
          reason: `Reverted punishment by moderator: ${revertResult}`,
        }),
      });
      if (!operation) return;
      const revertResult = operation.value;
      await deps.caseStore.addEvent(
        caseId,
        'reverted',
        'user',
        interaction.user.id,
        'Reverted punishment by moderator',
        { revertResult },
      );
      await interaction.update(
        caseReviewRevertUpdate(interaction.message.components, {
          caseId,
          punishment: config.policies.punishment,
        }),
      );
      return;
    }

    if (caseRow.status === 'dismissed') {
      const prevention =
        caseRow.triggerType === 'honeypot'
          ? config.policies.honeypot_prevention
          : config.policies.crosschannel_prevention;
      const operation = await runCaseOperation(interaction, deps, {
        caseId,
        operation: 'revert_dismissal',
        run: () =>
          deps.moderationQueue.enqueue(interaction.guildId, () =>
            applyPolicyForUser(
              interaction.guild,
              caseRow.userId,
              prevention,
              honeybotAuditReason({
                caseId,
                triggerType: caseRow.triggerType,
                decisionSource: 'dismissal-reverted',
                confidence: caseConfidence(caseRow.evidenceSummaryJson),
                actorId: interaction.user.id,
              }),
            ),
          ),
        completion: (applyResult) => ({
          actionTaken: prevention.actionType,
          reason: `Reverted dismissal; prevention reapplied: ${applyResult}`,
        }),
      });
      if (!operation) return;
      const applyResult = operation.value;
      await deps.caseStore.addEvent(
        caseId,
        'dismissal_reverted',
        'user',
        interaction.user.id,
        'Reverted dismissal and reapplied prevention',
        { applyResult },
      );
      await interaction.update(
        caseReviewRevertUpdate(interaction.message.components, {
          caseId,
          punishment: config.policies.punishment,
        }),
      );
      return;
    }

    await interaction.reply({
      content: 'Only dismissed or punished cases can be reverted.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: 'Unknown case action.', ephemeral: true });
}

async function runCaseOperation<T>(
  interaction: ButtonInteraction<'cached'>,
  deps: InteractionDependencies,
  input: {
    caseId: string;
    operation: CaseOperation;
    run: () => Promise<T>;
    completion: (value: T) => { actionTaken: string | null; reason: string };
  },
): Promise<{ value: T } | null> {
  const claimed = await deps.caseStore.claimOperation(
    input.caseId,
    input.operation,
    interaction.user.id,
  );
  if (!claimed) {
    await interaction.reply({
      content: 'Case already resolved by another moderator.',
      ephemeral: true,
    });
    return null;
  }

  try {
    const value = await input.run();
    const completion = input.completion(value);
    const completed = await deps.caseStore.completeOperation(
      input.caseId,
      input.operation,
      completion.actionTaken,
      interaction.user.id,
      completion.reason,
    );
    if (!completed)
      throw new Error('Case operation state changed unexpectedly');
    return { value };
  } catch (error) {
    await deps.caseStore.failOperation(
      input.caseId,
      input.operation,
      interaction.user.id,
      error,
    );
    await interaction.reply({
      content: `Case action failed; the case remains retryable. ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
    return null;
  }
}

async function revertPrevention(
  interaction: ButtonInteraction<'cached'>,
  caseRow: NonNullable<Awaited<ReturnType<CaseStore['getCase']>>>,
  config: GuildConfig,
) {
  const policy =
    caseRow.triggerType === 'honeypot'
      ? config.policies.honeypot_prevention
      : config.policies.crosschannel_prevention;
  return revertPolicyForUser(
    interaction.guild,
    caseRow.userId,
    policy,
    'Reverted Honeybot prevention action',
  );
}

function caseConfidence(evidenceSummaryJson: string) {
  try {
    const parsed = JSON.parse(evidenceSummaryJson) as { confidence?: unknown };
    return typeof parsed.confidence === 'number' ? parsed.confidence : null;
  } catch {
    return null;
  }
}

function isBooleanSetting(
  key: string | undefined,
): key is Extract<
  keyof GuildSettings,
  | 'crosschannelEnabled'
  | 'reviewBypassEnabled'
  | 'punishmentDmNotify'
  | 'globalBansEnabled'
> {
  return (
    key === 'crosschannelEnabled' ||
    key === 'reviewBypassEnabled' ||
    key === 'punishmentDmNotify' ||
    key === 'globalBansEnabled'
  );
}

function isModelPurpose(value: string | undefined): value is ModelPurpose {
  return modelPurposes.some((purpose) => purpose === value);
}

function isEmbeddingPurpose(purpose: ModelPurpose) {
  return purpose === 'text_embeddings' || purpose === 'image_embeddings';
}

function modelPageForPurpose(purpose: ModelPurpose): SettingsPage {
  return `model_${purpose}` as SettingsPage;
}

function isEditableSetting(key: string | undefined): key is EditableSetting {
  return (
    key === 'crosschannelMinimumWindowSeconds' ||
    key === 'crosschannelWindowSeconds' ||
    key === 'crosschannelWindowSteepness' ||
    key === 'crosschannelWindowMidpointChannels' ||
    key === 'crosschannelChannelThreshold' ||
    key === 'evidenceConfidenceThreshold' ||
    key === 'knownTextSimilarityThreshold' ||
    key === 'knownImageSimilarityThreshold' ||
    key === 'retentionCaseDays'
  );
}

function code(value: string) {
  return `\`\`\`\n${value}\n\`\`\``;
}
