import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { KnownScamImageImportResult } from '../services/caseStore.js';

export const CORPUS_UPLOAD_MODAL_ID = 'admin:corpusUpload';
export const CORPUS_UPLOAD_FILES_ID = 'admin:corpusUpload:files';
export const CORPUS_UPLOAD_REASON_ID = 'admin:corpusUpload:reason';
export const CORPUS_UPLOAD_ANOTHER_ID = 'admin:corpusUpload:another';

export function corpusUploadModal() {
  return new ModalBuilder()
    .setCustomId(CORPUS_UPLOAD_MODAL_ID)
    .setTitle('Add known scam images')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Scam images')
        .setDescription(
          'Upload up to 10 images. You can add another batch next.',
        )
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(CORPUS_UPLOAD_FILES_ID)
            .setMinValues(1)
            .setMaxValues(10)
            .setRequired(),
        ),
      new LabelBuilder()
        .setLabel('Reason or source')
        .setDescription(
          'Optional. Honeybot applies this note to the whole batch.',
        )
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(CORPUS_UPLOAD_REASON_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(500)
            .setRequired(false),
        ),
    );
}

export function corpusUploadReply(result: KnownScamImageImportResult) {
  const lines = result.items.map(
    (item) =>
      `${statusLabel(item.status)} \`${safeFileName(item.name)}\`: ${truncate(item.detail, 100)}`,
  );
  return {
    content: [
      `Corpus upload finished. Added ${result.added}, skipped ${result.skipped}, failed ${result.failed}.`,
      ...lines,
    ].join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(CORPUS_UPLOAD_ANOTHER_ID)
          .setLabel('Add another batch')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function statusLabel(
  status: KnownScamImageImportResult['items'][number]['status'],
) {
  switch (status) {
    case 'added':
      return 'Added';
    case 'skipped':
      return 'Skipped';
    case 'failed':
      return 'Failed';
  }
}

function safeFileName(value: string) {
  return truncate(value.replaceAll('`', "'").replace(/\s+/g, ' '), 55);
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
