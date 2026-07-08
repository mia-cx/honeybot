import {
  ActionRowBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type MessageCreateOptions,
} from 'discord.js';
import type {
  GuildConfig,
  ModelPurpose,
  Policy,
  PolicyScope,
} from '../domain/types.js';
import { formatPolicy } from '../services/configStore.js';

const COMPONENTS_V2 = 1 << 15;
const EPHEMERAL = 1 << 6;

export type SettingsPage =
  | 'none'
  | 'config'
  | 'triggers'
  | 'triggers_honeypots'
  | 'triggers_crosschannel'
  | 'policies'
  | 'policies_prevention'
  | 'policies_punishment'
  | 'permissions'
  | 'model'
  | 'model_text_classifier'
  | 'model_image_classifier'
  | 'model_text_embeddings'
  | 'model_image_embeddings';
export type EditableSetting =
  | 'crosschannelWindowSeconds'
  | 'crosschannelChannelThreshold'
  | 'evidenceConfidenceThreshold'
  | 'knownTextSimilarityThreshold'
  | 'knownImageSimilarityThreshold'
  | 'retentionCaseDays';

type RawComponent = { type: number; [key: string]: unknown };

type SettingsRouteId = Exclude<SettingsPage, 'none'>;
export type SettingsModelConfig = {
  purpose: ModelPurpose;
  provider: string;
  modelId: string | null;
  apiKeyHint: string | null;
};
export type SettingsAdditionalSignalConfig = {
  text: { provider: string; models: readonly string[] };
  image: { provider: string; models: readonly string[] };
};
type SettingsRenderContext = {
  config: GuildConfig;
  page: SettingsPage;
  policyScope: PolicyScope;
  models: Partial<Record<ModelPurpose, SettingsModelConfig>>;
  additionalSignals: SettingsAdditionalSignalConfig;
};
type SettingsRenderer = (context: SettingsRenderContext) => RawComponent[];
type SettingsSection = {
  title: string;
  body: (context: SettingsRenderContext) => string;
  controls: SettingsRenderer;
};
type SettingsNode = { id: SettingsRouteId; label: string; description: string };
type SettingsSubcategory = SettingsNode & { render: SettingsRenderer };
type SettingsCategory = SettingsNode & {
  render?: SettingsRenderer;
  subcategories?: SettingsSubcategory[];
};
type SettingsCategoryOptions = {
  render?: SettingsRenderer;
  subcategories?: SettingsSubcategory[];
};

type ModelSettingsPage = Extract<SettingsPage, `model_${string}`>;

const modelPageByPurpose: Record<ModelPurpose, ModelSettingsPage> = {
  text_classifier: 'model_text_classifier',
  image_classifier: 'model_image_classifier',
  text_embeddings: 'model_text_embeddings',
  image_embeddings: 'model_image_embeddings',
};

const modelPurposeLabels: Record<ModelPurpose, string> = {
  text_classifier: 'Text classifier',
  image_classifier: 'Image classifier',
  text_embeddings: 'Text embeddings',
  image_embeddings: 'Image embeddings',
};

const modelPurposeDescriptions: Record<ModelPurpose, string> = {
  text_classifier:
    'Scores text-only cases after cheap evidence checks are not decisive.',
  image_classifier:
    'Scores cases with image attachments after cheap evidence checks are not decisive.',
  text_embeddings: 'Retrieves nearby known text scams for evidence context.',
  image_embeddings: 'Retrieves nearby known image scams for evidence context.',
};

const emptyAdditionalSignals: SettingsAdditionalSignalConfig = {
  text: { provider: 'openrouter', models: [] },
  image: { provider: 'openrouter', models: [] },
};

const settingsCategories: SettingsCategory[] = [
  category(
    'config',
    'Config',
    'Case channel, auto-punish, thresholds, and user notifications',
    { render: configControls },
  ),
  category(
    'triggers',
    'Triggers',
    'Honeypot and cross-channel conditions that create cases',
    {
      subcategories: [
        subcategory(
          'triggers_honeypots',
          'Honeypots',
          'Trap channels that trigger immediately',
          honeypotControls,
        ),
        subcategory(
          'triggers_crosschannel',
          'Cross-channel',
          'Repeat spam detection across channels',
          crosschannelControls,
        ),
      ],
    },
  ),
  category(
    'policies',
    'Policies',
    'Prevention and punishment actions Honeybot can apply',
    {
      subcategories: [
        subcategory(
          'policies_prevention',
          'Prevention',
          'Immediate action after a trigger fires',
          preventionPolicyControls,
        ),
        subcategory(
          'policies_punishment',
          'Punishment',
          'Final action after moderator approval or auto-punish',
          punishmentPolicyControls,
        ),
      ],
    },
  ),
  category(
    'permissions',
    'Permissions',
    'Users and roles allowed to manage Honeybot',
    { render: permissionControls },
  ),
  category(
    'model',
    'Model',
    'Classifier and embedding model overrides plus BYOK API keys',
    {
      subcategories: [
        subcategory(
          'model_text_classifier',
          'Text classifier',
          modelPurposeDescriptions.text_classifier,
          (context) => modelPurposeControls(context, 'text_classifier'),
        ),
        subcategory(
          'model_image_classifier',
          'Image classifier',
          modelPurposeDescriptions.image_classifier,
          (context) => modelPurposeControls(context, 'image_classifier'),
        ),
        subcategory(
          'model_text_embeddings',
          'Text embeddings',
          modelPurposeDescriptions.text_embeddings,
          (context) => modelPurposeControls(context, 'text_embeddings'),
        ),
        subcategory(
          'model_image_embeddings',
          'Image embeddings',
          modelPurposeDescriptions.image_embeddings,
          (context) => modelPurposeControls(context, 'image_embeddings'),
        ),
      ],
    },
  ),
];

const settingsRoutes = settingsCategories.flatMap((settingsCategory) => [
  settingsCategory,
  ...(settingsCategory.subcategories ?? []),
]);
const settingsRouteById = new Map(
  settingsRoutes.map((route) => [route.id, route]),
);
const settingsParentByChildId = new Map(
  settingsCategories.flatMap((settingsCategory) =>
    (settingsCategory.subcategories ?? []).map((child) => [
      child.id,
      settingsCategory,
    ]),
  ),
);

const settingLabels: Record<EditableSetting, string> = {
  crosschannelWindowSeconds: 'Crosschannel window seconds',
  crosschannelChannelThreshold: 'Crosschannel channel threshold',
  evidenceConfidenceThreshold: 'Evidence threshold percent',
  knownTextSimilarityThreshold: 'Known text threshold percent',
  knownImageSimilarityThreshold: 'Known image threshold percent',
  retentionCaseDays: 'Case retention days',
};

const percentSettings = new Set<EditableSetting>([
  'evidenceConfidenceThreshold',
  'knownTextSimilarityThreshold',
  'knownImageSimilarityThreshold',
]);

export function settingsReply(
  config: GuildConfig,
  page: SettingsPage = 'none',
  policyScope: PolicyScope = 'punishment',
  models: SettingsModelConfig[] = [],
  additionalSignals: SettingsAdditionalSignalConfig = emptyAdditionalSignals,
): InteractionReplyOptions {
  return {
    flags: COMPONENTS_V2 | EPHEMERAL,
    components: settingsComponents(
      config,
      page,
      policyScope,
      models,
      additionalSignals,
    ),
  } as InteractionReplyOptions;
}

export function settingsUpdate(
  config: GuildConfig,
  page: SettingsPage,
  policyScope: PolicyScope = 'punishment',
  models: SettingsModelConfig[] = [],
  additionalSignals: SettingsAdditionalSignalConfig = emptyAdditionalSignals,
): InteractionUpdateOptions {
  return {
    components: settingsComponents(
      config,
      page,
      policyScope,
      models,
      additionalSignals,
    ),
  } as InteractionUpdateOptions;
}

export function honeypotWarningModal(
  channels: Array<{ id: string; name: string }>,
): ModalBuilder | null {
  if (channels.length === 0) return null;

  return new ModalBuilder()
    .setCustomId('settings:honeypotWarningModal')
    .setTitle('Send honeypot warning')
    .addLabelComponents((label) =>
      label
        .setLabel('Honeypot channel')
        .setDescription(
          'Choose the configured honeypot channel where Honeybot should post the public warning.',
        )
        .setStringSelectMenuComponent((select) =>
          select
            .setCustomId('settings:honeypotWarningChannel')
            .setPlaceholder('Choose a honeypot channel')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
              channels.slice(0, 25).map((channel) => ({
                label: `#${channel.name}`.slice(0, 100),
                value: channel.id,
              })),
            ),
        ),
    );
}

export function honeypotWarningSentReply(
  channelId: string,
): InteractionReplyOptions {
  return {
    flags: COMPONENTS_V2 | EPHEMERAL,
    components: [
      container([
        text(
          `## Honeypot warning sent\nPosted the public warning in <#${channelId}>.`,
        ),
      ]),
    ],
  } as InteractionReplyOptions;
}

export function honeypotWarningPublicMessage(
  config: GuildConfig,
): MessageCreateOptions {
  const policy = config.policies.honeypot_prevention;
  return {
    flags: COMPONENTS_V2,
    components: [
      container([
        text(
          '# 🍯 Honeypot warning\nThis channel is now watched by Honeybot as a honeypot.',
        ),
        separator(),
        text(
          `## Do not type messages here\nNormal users who post here will be **${policyActionPhrase(policy)}** immediately, and may receive further punitive action automatically.`,
        ),
        separator(),
        text(
          'Honeybot uses evidence checks and classifiers, but classifiers are not infallible. A false positive case may still lead to the configured final punishment, including a ban if this server has bans configured.',
        ),
      ]),
    ],
  } as MessageCreateOptions;
}

function policyActionPhrase(policy: Policy) {
  switch (policy.actionType) {
    case 'log':
      return 'logged';
    case 'timeout':
      return 'timed out';
    case 'role':
      return policy.roleId
        ? `given <@&${policy.roleId}>`
        : 'given the configured role';
    case 'kick':
      return 'kicked';
    case 'ban':
      return 'banned';
  }
}

export function pageFromValue(value: string | undefined): SettingsPage {
  return value && settingsRouteById.has(value as SettingsRouteId)
    ? (value as SettingsPage)
    : 'none';
}

export function pageForPolicyScope(scope: PolicyScope): SettingsPage {
  return scope === 'punishment' ? 'policies_punishment' : 'policies_prevention';
}

export function policyScopeFromValue(value: string | undefined): PolicyScope {
  return value === 'honeypot_prevention' ||
    value === 'crosschannel_prevention' ||
    value === 'punishment'
    ? value
    : 'punishment';
}

export function settingEditModal(
  key: EditableSetting,
  currentValue: string,
  page: SettingsPage,
) {
  return new ModalBuilder()
    .setCustomId(`settings:modal:${key}:${page}`)
    .setTitle(settingLabels[key])
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel(settingLabels[key])
          .setStyle(TextInputStyle.Short)
          .setValue(currentValue)
          .setRequired(true),
      ),
    );
}

export function policyDurationModal(
  scope: PolicyScope,
  currentValue: number | null,
) {
  return new ModalBuilder()
    .setCustomId(`settings:policyModal:duration:${scope}`)
    .setTitle(`Timeout duration: ${scope}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel('Duration seconds')
          .setStyle(TextInputStyle.Short)
          .setValue(String(currentValue ?? ''))
          .setRequired(false),
      ),
    );
}

export function modelConfigModal(
  purpose: ModelPurpose,
  current: SettingsModelConfig | undefined,
) {
  return new ModalBuilder()
    .setCustomId(`settings:modelModal:${purpose}`)
    .setTitle(`${modelPurposeLabels[purpose]} model`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('provider')
          .setLabel('Provider')
          .setStyle(TextInputStyle.Short)
          .setValue(current?.provider ?? 'openrouter')
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('model_id')
          .setLabel('Model ID')
          .setStyle(TextInputStyle.Short)
          .setValue(current?.modelId ?? '')
          .setRequired(false),
      ),
    );
}

export function modelApiKeyModal(purpose: ModelPurpose) {
  return new ModalBuilder()
    .setCustomId(`settings:modelKeyModal:${purpose}`)
    .setTitle(`${modelPurposeLabels[purpose]} API key`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('api_key')
          .setLabel('API key')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
}

export function settingInputValue(config: GuildConfig, key: EditableSetting) {
  const value = config[key];
  return percentSettings.has(key)
    ? String(Math.round(value * 100))
    : String(value);
}

export function parseEditableSettingValue(key: EditableSetting, raw: string) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  if (percentSettings.has(key)) {
    if (value > 100) return null;
    return value / 100;
  }
  if (!Number.isInteger(value)) return null;
  return value;
}

function settingsComponents(
  config: GuildConfig,
  page: SettingsPage,
  policyScope: PolicyScope,
  models: SettingsModelConfig[],
  additionalSignals: SettingsAdditionalSignalConfig,
): RawComponent[] {
  const context = {
    config,
    page,
    policyScope,
    models: Object.fromEntries(
      models.map((model) => [model.purpose, model]),
    ) as Partial<Record<ModelPurpose, SettingsModelConfig>>,
    additionalSignals,
  };
  const selectedCategory = categoryForPage(page);
  const selectedSubcategory = subcategoryForPage(page);

  return [
    settingsHomeContainer(page),
    ...(selectedCategory ? [categoryContainer(context, selectedCategory)] : []),
    ...(selectedSubcategory
      ? [subcategoryContainer(context, selectedSubcategory)]
      : []),
  ];
}

function settingsHomeContainer(page: SettingsPage): RawComponent {
  return container([
    text(
      '# 🍯 Honeybot\nHoneybot catches scam raids with honeypot channels, cross-channel duplicate detection, evidence signals, and moderator review. Configure what it watches, who reviews cases, and which actions it can apply.',
    ),
    separator(),
    text('## Settings'),
    pageSelect(page),
  ]);
}

function categoryContainer(
  context: SettingsRenderContext,
  selectedCategory: SettingsCategory,
): RawComponent {
  const hasSubcategories = Boolean(selectedCategory.subcategories?.length);
  return container([
    text(`# ${selectedCategory.label}\n${selectedCategory.description}`),
    separator(),
    ...subcategorySelect(selectedCategory, context.page),
    ...(selectedCategory.render ? renderNode(selectedCategory, context) : []),
    ...(hasSubcategories || selectedCategory.render
      ? []
      : renderNode(selectedCategory, context)),
  ]);
}

function subcategoryContainer(
  context: SettingsRenderContext,
  selectedSubcategory: SettingsSubcategory,
): RawComponent {
  return container([
    text(`# ${selectedSubcategory.label}\n${selectedSubcategory.description}`),
    separator(),
    ...renderNode(selectedSubcategory, context),
  ]);
}

function renderNode(
  node: SettingsCategory | SettingsSubcategory,
  context: SettingsRenderContext,
): RawComponent[] {
  return node.render?.(context) ?? [];
}

function categoryForPage(page: SettingsPage): SettingsCategory | undefined {
  if (page === 'none') return undefined;
  return (
    settingsParentByChildId.get(page as SettingsRouteId) ??
    (settingsRouteById.get(page as SettingsRouteId) as
      SettingsCategory | undefined)
  );
}

function subcategoryForPage(
  page: SettingsPage,
): SettingsSubcategory | undefined {
  if (page === 'none') return undefined;
  return settingsParentByChildId.has(page as SettingsRouteId)
    ? (settingsRouteById.get(page as SettingsRouteId) as
        SettingsSubcategory | undefined)
    : undefined;
}

function pageSelect(current: SettingsPage): RawComponent {
  const selectedCategory = categoryForPage(current);
  return selectRow({
    type: 3,
    custom_id: 'settings:page',
    placeholder: 'Choose a settings category',
    min_values: 1,
    max_values: 1,
    options: settingsCategories.map((settingsCategory) => ({
      label: settingsCategory.label,
      value: settingsCategory.id,
      description: settingsCategory.description,
      default: settingsCategory.id === selectedCategory?.id,
    })),
  });
}

function subcategorySelect(
  selectedCategory: SettingsCategory,
  current: SettingsPage,
): RawComponent[] {
  if (!selectedCategory.subcategories?.length) return [];
  return [
    selectRow({
      type: 3,
      custom_id: `settings:subcategory:${selectedCategory.id}`,
      placeholder: 'Choose a sub-category',
      min_values: 1,
      max_values: 1,
      options: selectedCategory.subcategories.map((option) => ({
        label: option.label,
        value: option.id,
        description: option.description,
        default: option.id === current,
      })),
    }),
    separator(),
  ];
}

function category(
  id: SettingsRouteId,
  label: string,
  description: string,
  options: SettingsCategoryOptions,
): SettingsCategory {
  return { id, label, description, ...options };
}

function subcategory(
  id: SettingsRouteId,
  label: string,
  description: string,
  render: SettingsRenderer,
): SettingsSubcategory {
  return { id, label, description, render };
}

function settingsSection(
  title: string,
  body: string | ((context: SettingsRenderContext) => string),
  controls: SettingsRenderer = () => [],
): SettingsSection {
  return {
    title,
    body: typeof body === 'function' ? body : () => body,
    controls,
  };
}

function renderSections(
  context: SettingsRenderContext,
  sections: SettingsSection[],
): RawComponent[] {
  return sections.flatMap((section, index) => [
    ...(index > 0 ? [separator()] : []),
    text(`## ${section.title}\n${section.body(context)}`),
    separator(),
    ...section.controls(context),
  ]);
}

function honeypotControls(context: SettingsRenderContext): RawComponent[] {
  return renderSections(context, [
    settingsSection(
      'Honeypot channels',
      'Pick every trap channel. Saving this selector replaces the full honeypot list.',
      ({ config }) => [
        selectRow({
          type: 8,
          custom_id: 'settings:channels:honeypots:triggers_honeypots',
          channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
          placeholder: 'Replace honeypot channel list',
          min_values: 0,
          max_values: 25,
          ...defaultValues(config.honeypotChannelIds, 'channel'),
        }),
        buttonRow([
          button(
            'settings:honeypotWarning:open:triggers_honeypots',
            'Send honeypot warning',
            2,
          ),
        ]),
      ],
    ),
  ]);
}

function crosschannelControls(context: SettingsRenderContext): RawComponent[] {
  return renderSections(context, [
    settingsSection(
      'Detection state',
      ({ config }) =>
        `Cross-channel matching is currently **${onOff(config.crosschannelEnabled)}**.`,
      ({ config }) => [
        buttonRow([
          button(
            'settings:toggle:crosschannelEnabled:triggers_crosschannel',
            config.crosschannelEnabled
              ? 'Disable cross-channel'
              : 'Enable cross-channel',
            config.crosschannelEnabled ? 4 : 3,
          ),
        ]),
      ],
    ),
    settingsSection(
      'Match window',
      ({ config }) =>
        `Messages must repeat across **${config.crosschannelChannelThreshold}** distinct channels within **${config.crosschannelWindowSeconds}s**.`,
      () => [
        buttonRow([
          button(
            'settings:edit:crosschannelChannelThreshold:triggers_crosschannel',
            'Edit channel count',
            2,
          ),
          button(
            'settings:edit:crosschannelWindowSeconds:triggers_crosschannel',
            'Edit window',
            2,
          ),
        ]),
      ],
    ),
  ]);
}

function permissionControls(context: SettingsRenderContext): RawComponent[] {
  return renderSections(context, [
    settingsSection(
      'Moderator access',
      'These users and roles can configure Honeybot and are bypassed by automated scans.',
      ({ config }) => [
        selectRow({
          type: 7,
          custom_id: 'settings:mentionables:moderators:permissions',
          placeholder: 'Replace moderator users and roles',
          min_values: 0,
          max_values: 25,
          ...mentionableDefaultValues(config),
        }),
      ],
    ),
  ]);
}

function configControls(context: SettingsRenderContext): RawComponent[] {
  return renderSections(context, [
    settingsSection(
      'Case feed',
      'Choose where Honeybot posts moderation cases. Cases are posted immediately, then edited as signals arrive.',
      ({ config }) => [
        selectRow({
          type: 8,
          custom_id: 'settings:channel:moderationChannelId:config',
          channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
          placeholder: 'Set moderation review channel',
          min_values: 0,
          max_values: 1,
          ...defaultValues(
            config.moderationChannelId ? [config.moderationChannelId] : [],
            'channel',
          ),
        }),
      ],
    ),
    settingsSection(
      'Auto-punish',
      ({ config }) =>
        `Status: **${onOff(config.reviewBypassEnabled)}** · Evidence threshold: **${Math.round(config.evidenceConfidenceThreshold * 100)}%**\nWhen enabled, Honeybot can apply the punishment policy only after evidence clears this threshold.`,
      ({ config }) => [
        buttonRow([
          button(
            'settings:toggle:reviewBypassEnabled:config',
            config.reviewBypassEnabled
              ? 'Disable auto-punish'
              : 'Enable auto-punish',
            config.reviewBypassEnabled ? 4 : 3,
          ),
          button(
            'settings:edit:evidenceConfidenceThreshold:config',
            'Edit threshold',
            2,
          ),
        ]),
      ],
    ),
    settingsSection(
      'DM notifications',
      ({ config }) =>
        `Status: **${onOff(config.punishmentDmNotify)}**\nWhen enabled, Honeybot sends the user a case summary before applying the final punishment when Discord allows it.`,
      ({ config }) => [
        buttonRow([
          button(
            'settings:toggle:punishmentDmNotify:config',
            config.punishmentDmNotify ? 'Disable DMs' : 'Enable DMs',
            config.punishmentDmNotify ? 4 : 3,
          ),
        ]),
      ],
    ),
    settingsSection(
      'Global bans',
      ({ config }) =>
        `Status: **${onOff(config.globalBansEnabled)}**\nWhen enabled, this server consumes global bans published by Honeybot global admins.`,
      ({ config }) => [
        buttonRow([
          button(
            'settings:toggle:globalBansEnabled:config',
            config.globalBansEnabled
              ? 'Opt out of global bans'
              : 'Opt in to global bans',
            config.globalBansEnabled ? 4 : 3,
          ),
        ]),
      ],
    ),
  ]);
}

function secondaryModelList(input: {
  provider: string;
  models: readonly string[];
}) {
  if (input.models.length === 0) return '-# None configured.';
  return input.models.map((model) => `- ${input.provider}/${model}`).join('\n');
}

function modelPurposeControls(
  context: SettingsRenderContext,
  purpose: ModelPurpose,
): RawComponent[] {
  const page = modelPageByPurpose[purpose];
  return renderSections(context, [
    settingsSection(
      'Configuration',
      ({ models }) => {
        const model = models[purpose];
        return [
          `Provider: **${model?.provider ?? 'bot default'}**`,
          `Model: **${model?.modelId ?? 'bot default'}**`,
          `Guild BYOK key: **${model?.apiKeyHint ?? 'not set'}**`,
        ].join('\n');
      },
      ({ models }) => [
        buttonRow([
          button(
            `settings:modelEdit:${purpose}:${page}`,
            'Edit provider/model',
            2,
          ),
          button(`settings:modelKey:${purpose}:${page}`, 'Set API key', 2),
          button(
            `settings:modelClearKey:${purpose}:${page}`,
            'Clear API key',
            models[purpose]?.apiKeyHint ? 4 : 2,
          ),
        ]),
      ],
    ),
    ...additionalSignalSections(purpose),
  ]);
}

function additionalSignalSections(purpose: ModelPurpose): SettingsSection[] {
  if (purpose === 'text_classifier') {
    return [
      settingsSection(
        'Additional advisory signal models',
        'These secondary text classifier models run after the primary text classifier. They are not guild-editable and never trigger punishment by themselves.',
        ({ additionalSignals }) => [
          text(secondaryModelList(additionalSignals.text)),
        ],
      ),
    ];
  }
  if (purpose === 'image_classifier') {
    return [
      settingsSection(
        'Additional advisory signal models',
        'These secondary image classifier models run after the primary image classifier. They are not guild-editable and never trigger punishment by themselves.',
        ({ additionalSignals }) => [
          text(secondaryModelList(additionalSignals.image)),
        ],
      ),
    ];
  }
  return [];
}

function preventionPolicyControls(
  context: SettingsRenderContext,
): RawComponent[] {
  return renderSections(context, [
    policySection(
      'Honeypot prevention',
      'Runs immediately when a non-bypassed user posts in a honeypot channel.',
      'honeypot_prevention',
    ),
    policySection(
      'Cross-channel prevention',
      'Runs immediately when a user repeats matching content across enough distinct channels.',
      'crosschannel_prevention',
    ),
  ]);
}

function punishmentPolicyControls(
  context: SettingsRenderContext,
): RawComponent[] {
  return renderSections(context, [
    policySection(
      'Punishment',
      'Runs after moderator approval, or after auto-punish evidence clears the configured threshold.',
      'punishment',
    ),
  ]);
}

function policySection(
  title: string,
  description: string,
  scope: PolicyScope,
): SettingsSection {
  return settingsSection(
    title,
    ({ config }) =>
      `${description}\nCurrent policy: **${formatPolicy(config.policies[scope])}**`,
    ({ config }) => policyControls(config, scope),
  );
}

function policyControls(
  config: GuildConfig,
  scope: PolicyScope,
): RawComponent[] {
  const policy = config.policies[scope];
  const actionOptions =
    scope === 'punishment'
      ? ['timeout', 'role', 'kick', 'ban']
      : ['log', 'timeout', 'role', 'kick', 'ban'];
  const timedAction =
    policy.actionType === 'timeout' || policy.actionType === 'role';

  return [
    selectRow({
      type: 3,
      custom_id: `settings:policyAction:${scope}`,
      placeholder: 'Choose action',
      min_values: 1,
      max_values: 1,
      options: actionOptions.map((action) => ({
        label: action,
        value: action,
        default: policy.actionType === action,
      })),
    }),
    ...(policy.actionType === 'role'
      ? [
          selectRow({
            type: 6,
            custom_id: `settings:policyRole:${scope}`,
            placeholder: policy.roleId
              ? `Role action target: ${policy.roleId}`
              : 'Set role for role action',
            min_values: 0,
            max_values: 1,
            ...defaultValues(policy.roleId ? [policy.roleId] : [], 'role'),
          }),
        ]
      : []),
    buttonRow([
      ...(timedAction
        ? [button(`settings:policyDuration:${scope}`, 'Edit duration', 2)]
        : []),
      button(
        `settings:policyDelete:${scope}`,
        policy.deleteMessages ? 'Disable deletes' : 'Enable deletes',
        policy.deleteMessages ? 4 : 3,
      ),
    ]),
  ];
}

function container(components: RawComponent[]): RawComponent {
  return {
    type: 17,
    accent_color: 0xfacc15,
    components: withoutTrailingSeparators(components),
  };
}

function withoutTrailingSeparators(components: RawComponent[]) {
  let end = components.length;
  while (end > 0 && components[end - 1]?.type === 14) end -= 1;
  return components.slice(0, end);
}

function text(content: string): RawComponent {
  return { type: 10, content };
}

function separator(): RawComponent {
  return { type: 14, divider: true, spacing: 1 };
}

function selectRow(component: RawComponent): RawComponent {
  return { type: 1, components: [component] };
}

function defaultValues(ids: string[], type: 'channel' | 'role' | 'user') {
  return ids.length > 0
    ? { default_values: ids.slice(0, 25).map((id) => ({ id, type })) }
    : {};
}

function mentionableDefaultValues(config: GuildConfig) {
  const defaultValues = [
    ...config.moderatorUsers.map((id) => ({ id, type: 'user' })),
    ...config.moderatorRoles.map((id) => ({ id, type: 'role' })),
  ].slice(0, 25);
  return defaultValues.length > 0 ? { default_values: defaultValues } : {};
}

function buttonRow(components: RawComponent[]): RawComponent {
  return { type: 1, components };
}

function button(
  customId: string,
  label: string,
  style: 1 | 2 | 3 | 4,
): RawComponent {
  return { type: 2, custom_id: customId, label, style };
}

function onOff(value: boolean) {
  return value ? 'on' : 'off';
}
