import {
  AttachmentBuilder,
  type InteractionUpdateOptions,
  type MessageCreateOptions,
  type MessageEditOptions,
} from 'discord.js';
import type { AnalysisResult, Policy } from '../domain/types.js';
import type { FileStorage } from '../storage/fileStorage.js';

const COMPONENTS_V2 = 1 << 15;

export type CaseReviewInput = {
  caseId: string;
  userId: string;
  channelId: string;
  triggerType: string;
  duplicateChannelIds: string[];
  moderatorUserIds: string[];
  moderatorRoleIds: string[];
  status: string;
  reason: string;
  messageContent: string;
  attachments: CaseAttachment[];
  storage: FileStorage;
  prevention: Policy;
  punishment: Policy;
  preventionApplied: boolean;
  preventionAppliedAtMs: number;
  triggerMessageDeleted: boolean;
  analysis: AnalysisResult | null;
};

type RawComponent = { type: number; [key: string]: unknown };

type CaseAttachment = {
  id: number;
  name: string | null;
  contentType: string | null;
  sizeBytes: number;
  storageKey: string | null;
  discordAttachmentId: string;
};

export function caseReviewMessage(
  input: CaseReviewInput,
): MessageCreateOptions {
  const files = reviewFiles(input.attachments, input.storage);
  return {
    flags: COMPONENTS_V2,
    files: files.map((file) => file.attachment),
    components: caseReviewComponents(
      input,
      files.map((file) => file.filename),
    ),
    allowedMentions: allowedMentions(input),
  } as MessageCreateOptions;
}

export function caseReviewEdit(input: CaseReviewInput): MessageEditOptions {
  const files = reviewFiles(input.attachments, input.storage);
  return {
    files: files.map((file) => file.attachment),
    components: caseReviewComponents(
      input,
      files.map((file) => file.filename),
    ),
    allowedMentions: allowedMentions(input),
  } as MessageEditOptions;
}

export function caseReviewResolutionUpdate(
  existingComponents: readonly unknown[],
  input: {
    caseId: string;
    status: 'dismissed' | 'punished';
    actorId: string;
    userId: string;
    detail: string;
    punishment: Policy;
    canRevert: boolean;
  },
): InteractionUpdateOptions {
  return {
    components: [
      ...withoutResolutionOrActions(existingComponents),
      resolutionContainer(input),
      buttonRow(
        resolvedActionButtons(
          input.caseId,
          input.punishment,
          input.status,
          input.canRevert,
        ),
      ),
    ],
  } as InteractionUpdateOptions;
}

export function caseReviewRevertUpdate(
  existingComponents: readonly unknown[],
  input: { caseId: string; punishment: Policy },
): InteractionUpdateOptions {
  return {
    components: [
      ...withoutResolutionOrActions(existingComponents),
      buttonRow(
        caseActionButtons({
          caseId: input.caseId,
          punishment: input.punishment,
        }),
      ),
    ],
  } as InteractionUpdateOptions;
}

function caseReviewComponents(
  input: CaseReviewInput,
  attachmentFilenames: string[],
): RawComponent[] {
  return [
    text(
      `${moderatorMentions(input)} new case triggered by ${triggerDescription(input)}`,
    ),
    container([
      text(
        [
          `# 🍯 Case \`${input.caseId}\``,
          `-# Triggered by: <@${input.userId}>`,
        ].join('\n'),
      ),
      separator(),
      text(
        [
          '## Original Message',
          input.messageContent
            ? quote(input.messageContent, 1600)
            : '_empty or attachment-only_',
        ].join('\n'),
      ),
      ...(attachmentFilenames.length > 0
        ? [mediaGallery(attachmentFilenames)]
        : []),
      separator(),
      text(['## Prevention', preventionSummary(input)].join('\n')),
    ]),
    signalsContainer(input),
    buttonRow(caseActionButtons(input)),
  ];
}

type SignalInput = { analysis: AnalysisResult | null; reason: string };

function signalsContainer(input: SignalInput): RawComponent {
  return container(
    [
      text(
        [
          `# ⚠️ Signals`,
          `-# Likelihood of being a scam: ${confidenceLabel(input.analysis?.confidence)}`,
        ].join('\n'),
      ),
      separator(),
      signalBlock('Matches', matchSummary(input.analysis)),
      separator(),
      signalBlock(
        'Embeddings',
        signalSummary(
          input.analysis,
          'embedding_retrieval',
          'No embedding proximity signal has been recorded yet.',
        ),
      ),
      separator(),
      signalBlock(
        'Classifier verdict',
        classifierSummary(input.analysis, input.reason),
      ),
    ],
    0xfacc15,
  );
}

function signalBlock(title: string, body: string): RawComponent {
  return text([`### ${title}`, body].join('\n'));
}

function caseActionButtons(input: {
  caseId: string;
  punishment: Policy;
  status?: string;
}) {
  if (input.status && isPunishedStatus(input.status))
    return resolvedActionButtons(
      input.caseId,
      input.punishment,
      'punished',
      reversiblePolicy(input.punishment),
    );

  return [
    button(
      `case:punish:${input.caseId}`,
      punishmentButtonLabel(input.punishment),
      4,
    ),
    button(`case:dismiss:${input.caseId}`, 'Dismiss case', 2),
  ];
}

function resolvedActionButtons(
  caseId: string,
  punishment: Policy,
  status: 'dismissed' | 'punished',
  canRevert: boolean,
) {
  return [
    button(`case:punish:${caseId}`, punishmentButtonLabel(punishment), 4, true),
    button(`case:dismiss:${caseId}`, 'Dismiss case', 2, true),
    button(
      `case:revert:${caseId}`,
      status === 'punished' ? `Revert ${punishment.actionType}` : 'Revert',
      1,
      !canRevert,
    ),
  ];
}

function resolutionContainer(input: {
  status: 'dismissed' | 'punished';
  actorId: string;
  userId: string;
  detail: string;
  punishment: Policy;
}): RawComponent {
  return container([
    text(
      [resolutionTitle(input), `-# Resolved by <@${input.actorId}>`].join('\n'),
    ),
    separator(),
    text(quote(input.detail, 900)),
  ]);
}

function resolutionTitle(input: {
  status: 'dismissed' | 'punished';
  userId: string;
  punishment: Policy;
}) {
  if (input.status === 'dismissed') return '# ✅ Case dismissed';

  switch (input.punishment.actionType) {
    case 'ban':
      return `# 🔨 <@${input.userId}> banned`;
    case 'kick':
      return `# 🥾 <@${input.userId}> kicked`;
    case 'timeout':
      return `# ⏱️ <@${input.userId}> timed out for ${durationLabel(input.punishment.durationSeconds ?? 1_800)}`;
    case 'role':
      return input.punishment.roleId
        ? `# 🏷️ <@&${input.punishment.roleId}> applied`
        : '# 🏷️ Role policy applied';
    case 'log':
      return '# ✅ Punishment logged';
  }
}

function withoutResolutionOrActions(existingComponents: readonly unknown[]) {
  return existingComponents
    .map((component) => cloneComponent(component))
    .filter((component) => !isResolutionContainer(component))
    .filter((component) => component.type !== 1);
}

function cloneComponent(component: unknown): RawComponent {
  if (
    component &&
    typeof component === 'object' &&
    'toJSON' in component &&
    typeof component.toJSON === 'function'
  )
    return component.toJSON() as RawComponent;
  return component as RawComponent;
}

function isResolutionContainer(component: RawComponent) {
  if (component.type !== 17 || !Array.isArray(component.components))
    return false;
  return component.components.some(
    (child) =>
      typeof child?.content === 'string' &&
      child.content.includes('-# Resolved by <@'),
  );
}

function preventionSummary(input: CaseReviewInput) {
  const parts = [] as string[];
  if (input.triggerMessageDeleted) parts.push('Original message was deleted');
  else if (input.prevention.deleteMessages)
    parts.push('Original message deletion was attempted');
  else parts.push('Original message was left in place');

  parts.push(
    policyAppliedSummary(
      input.prevention,
      input.userId,
      input.preventionAppliedAtMs,
    ),
  );
  return sentence(parts);
}

function policyAppliedSummary(
  policy: Policy,
  userId: string,
  appliedAtMs: number,
) {
  switch (policy.actionType) {
    case 'log':
      return 'case was logged for review';
    case 'timeout': {
      const until = Math.floor(
        (appliedAtMs + (policy.durationSeconds ?? 1_800) * 1000) / 1000,
      );
      return `<@${userId}> was timed out until <t:${until}:F> (<t:${until}:R>)`;
    }
    case 'role':
      return policy.roleId
        ? `<@${userId}> was given <@&${policy.roleId}>`
        : `<@${userId}> matched a role policy with no role configured`;
    case 'kick':
      return `<@${userId}> was kicked`;
    case 'ban':
      return `<@${userId}> was banned`;
  }
}

function matchSummary(analysis: AnalysisResult | null) {
  return [
    signalSummary(
      analysis,
      'exact_match',
      'No exact matches found with the known scam database.',
    ),
    signalSummary(
      analysis,
      'fuzzy_match',
      'No fuzzy similarity to known scams found.',
    ),
  ].join('\n');
}

function signalSummary(
  analysis: AnalysisResult | null,
  type: AnalysisResult['evidence'][number]['type'],
  empty: string,
) {
  if (!analysis) return '_Pending._';
  const items = analysis.evidence.filter((item) => item.type === type);
  if (items.length === 0) return empty;
  return items
    .sort((a, b) => b.score - a.score)
    .map(formatSignalItem)
    .join('\n');
}

function formatSignalItem(item: AnalysisResult['evidence'][number]) {
  return startsWithPercent(item.summary)
    ? item.summary
    : `${Math.round(item.score * 100)}% ${item.summary}`;
}

function startsWithPercent(value: string) {
  return /^\d+%(?:\s|$)/.test(value.trim());
}

function classifierSummary(
  analysis: AnalysisResult | null,
  fallbackReason: string,
) {
  if (!analysis) return '_Pending classifier response._';
  const classifiers = analysis.evidence.filter(
    (item) => item.type === 'classifier',
  );
  if (classifiers.length === 0)
    return fallbackReason
      ? quote(fallbackReason, 700)
      : '_Classifier has not run yet._';
  return classifiers.map(classifierSignalSummary).join('\n\n');
}

function classifierSignalSummary(item: AnalysisResult['evidence'][number]) {
  const label =
    item.metadata?.source === 'additional_signal'
      ? `Secondary model ${item.metadata.modelId ?? 'unknown'}`
      : 'Primary model';
  return [
    `**${label}** — likelihood of scam: ${Math.round(item.score * 100)}%`,
    quote(item.summary, 700),
  ].join('\n');
}

function triggerDescription(input: CaseReviewInput) {
  if (input.triggerType === 'honeypot')
    return `message in <#${input.channelId}>`;
  const channels = [...new Set([input.channelId, ...input.duplicateChannelIds])]
    .map((id) => `<#${id}>`)
    .join(', ');
  return `duplicate messages across ${channels || `<#${input.channelId}>`}`;
}

function moderatorMentions(input: CaseReviewInput) {
  const mentions = [
    ...input.moderatorRoleIds.map((id) => `<@&${id}>`),
    ...input.moderatorUserIds.map((id) => `<@${id}>`),
  ];
  return mentions.length > 0 ? mentions.join(' ') : '@moderators';
}

function reviewFiles(attachments: CaseAttachment[], storage: FileStorage) {
  return attachments
    .filter(
      (attachment) =>
        attachment.storageKey &&
        attachment.contentType?.startsWith('image/') &&
        attachment.sizeBytes <= 8 * 1024 * 1024,
    )
    .slice(0, 10)
    .map((attachment) => {
      const filename = `SPOILER_${attachment.id}_${safeName(attachment.name ?? `${attachment.discordAttachmentId}.bin`)}`;
      return {
        filename,
        attachment: new AttachmentBuilder(
          storage.pathFor(attachment.storageKey!),
          { name: filename },
        ),
      };
    });
}

function allowedMentions(input: CaseReviewInput) {
  return {
    users: [input.userId, ...input.moderatorUserIds],
    roles: input.moderatorRoleIds,
  };
}

function container(
  components: RawComponent[],
  accentColor = 0xfacc15,
): RawComponent {
  return { type: 17, accent_color: accentColor, components };
}

function text(content: string): RawComponent {
  return { type: 10, content };
}

function mediaGallery(attachmentFilenames: string[]): RawComponent {
  return {
    type: 12,
    items: attachmentFilenames.slice(0, 10).map((filename) => ({
      media: { url: `attachment://${filename}` },
      description: `Evidence attachment ${filename.replace(/^SPOILER_/, '')}`,
      spoiler: true,
    })),
  };
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

function punishmentButtonLabel(policy: Policy) {
  switch (policy.actionType) {
    case 'timeout':
      return `Timeout user`;
    case 'role':
      return policy.roleId ? `Apply role` : 'Apply role policy';
    case 'kick':
      return 'Kick user';
    case 'ban':
      return 'Ban user';
    case 'log':
      return 'Log action';
  }
}

function reversiblePolicy(policy: Policy) {
  return (
    policy.actionType === 'timeout' ||
    policy.actionType === 'role' ||
    policy.actionType === 'ban'
  );
}

function isPunishedStatus(status: string) {
  return status.toLowerCase().includes('punished');
}

function durationLabel(seconds: number) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function sentence(parts: string[]) {
  const [first, ...rest] = parts;
  if (!first) return '';
  return `${first}${rest.length > 0 ? ` and ${rest.join(' and ')}` : ''}.`;
}

function confidenceLabel(confidence: number | undefined) {
  return confidence === undefined
    ? 'pending'
    : `${Math.round(confidence * 100)}%`;
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'attachment.bin';
}

function quote(value: string, max: number) {
  return `> ${truncate(value, max).replace(/\n/g, '\n> ')}`;
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
