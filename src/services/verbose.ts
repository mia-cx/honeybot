let verboseLoggingEnabled = false;

export function toggleVerboseLogging() {
  verboseLoggingEnabled = !verboseLoggingEnabled;
  logVerboseState('toggled');
  return verboseLoggingEnabled;
}

export function isVerboseLoggingEnabled() {
  return verboseLoggingEnabled;
}

export function logVerboseJson(label: string, payload: unknown) {
  if (!verboseLoggingEnabled) return;
  writeVerbose(label, payload);
}

function logVerboseState(reason: string) {
  writeVerbose(`verbose.${reason}`, { enabled: verboseLoggingEnabled });
}

function writeVerbose(label: string, payload: unknown) {
  // Use stderr so verbose model traces show up alongside bot errors in process logs.
  process.stderr.write(`[honeybot:verbose] ${label}\n`);
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
}
