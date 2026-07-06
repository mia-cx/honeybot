import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { env } from './env.js';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/);

const scamActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ban'),
    deleteMessageSeconds: z.number().int().min(0).max(604800).optional(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('timeout'),
    durationSeconds: z.number().int().min(1).max(2419200),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('role'),
    roleId: snowflakeSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('deleteOnly'),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('logOnly'),
    reason: z.string().min(1),
  }),
]);

const guildConfigSchema = z.object({
  honeypotChannelIds: z.array(snowflakeSchema).default([]),
  bypassRoleIds: z.array(snowflakeSchema).default([]),
  bypassUserIds: z.array(snowflakeSchema).default([]),
  honeypotTimeoutSeconds: z.number().int().min(1).max(2419200).default(3600),
  duplicateWindowSeconds: z.number().int().min(1).default(60),
  duplicateChannelThreshold: z.number().int().min(2).default(2),
  scamAction: scamActionSchema.default({
    type: 'logOnly',
    reason: 'Classified as scam by Honeybot',
  }),
  moderationLogChannelId: snowflakeSchema.optional(),
});

const configSchema = z.object({
  guilds: z.record(snowflakeSchema, guildConfigSchema).default({}),
  globalBanList: z
    .object({
      enabled: z.boolean().default(false),
      endpoint: z.string().url().nullable().default(null),
    })
    .default({ enabled: false, endpoint: null }),
});

export type LoadedConfig = z.infer<typeof configSchema>;

export async function loadConfig(path = env.CONFIG_PATH): Promise<LoadedConfig> {
  const raw = await readFile(path, 'utf8');
  return configSchema.parse(JSON.parse(raw));
}
