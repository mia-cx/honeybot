let verboseLoggingEnabled = false;

export function toggleVerboseLogging() {
  verboseLoggingEnabled = !verboseLoggingEnabled;
  return verboseLoggingEnabled;
}

export function isVerboseLoggingEnabled() {
  return verboseLoggingEnabled;
}

export function logVerboseJson(label: string, payload: unknown) {
  if (!verboseLoggingEnabled) return;
  console.log(`[honeybot:verbose] ${label}`);
  console.log(JSON.stringify(payload, null, 2));
}
