import { and, eq } from 'drizzle-orm';
import { settings } from '../db/schema.js';
import type { Db } from '../db/database.js';

const globalSettingsGuildId = '__honeybot_global__';
const verboseModelLoggingKey = 'admin:verbose_model_logging';

let verboseLoggingEnabled = false;

export async function loadVerboseLogging(db: Db) {
  verboseLoggingEnabled = await readVerboseLogging(db);
  if (verboseLoggingEnabled) logVerboseState('loaded');
  return verboseLoggingEnabled;
}

export async function toggleVerboseLogging(db: Db) {
  const enabled = !(await readVerboseLogging(db));
  await setVerboseLogging(db, enabled);
  logVerboseState('toggled');
  return enabled;
}

export async function setVerboseLogging(db: Db, enabled: boolean) {
  const now = new Date().toISOString();
  await db
    .insert(settings)
    .values({
      guildId: globalSettingsGuildId,
      key: verboseModelLoggingKey,
      value: String(enabled),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [settings.guildId, settings.key],
      set: { value: String(enabled), updatedAt: now },
    });
  verboseLoggingEnabled = enabled;
}

export function isVerboseLoggingEnabled() {
  return verboseLoggingEnabled;
}

export function logVerboseJson(label: string, payload: unknown) {
  if (!verboseLoggingEnabled) return;
  writeVerbose(label, payload);
}

async function readVerboseLogging(db: Db) {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.guildId, globalSettingsGuildId),
        eq(settings.key, verboseModelLoggingKey),
      ),
    )
    .get();
  return row?.value === 'true';
}

function logVerboseState(reason: string) {
  writeVerbose(`verbose.${reason}`, { enabled: verboseLoggingEnabled });
}

function writeVerbose(label: string, payload: unknown) {
  // Use stderr so verbose model traces show up alongside bot errors in process logs.
  process.stderr.write(`[honeybot:verbose] ${label}\n`);
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
}
