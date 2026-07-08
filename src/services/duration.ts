const unitSeconds = {
  w: 7 * 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  weeks: 7 * 24 * 60 * 60,
  d: 24 * 60 * 60,
  day: 24 * 60 * 60,
  days: 24 * 60 * 60,
  h: 60 * 60,
  hr: 60 * 60,
  hrs: 60 * 60,
  hour: 60 * 60,
  hours: 60 * 60,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
} as const;

export function formatDurationSeconds(seconds: number | null) {
  if (seconds === null) return '';
  if (seconds === 0) return '0s';
  const sign = seconds < 0 ? '-' : '';
  let remaining = Math.abs(seconds);
  const days = Math.floor(remaining / unitSeconds.d);
  remaining -= days * unitSeconds.d;
  const hours = Math.floor(remaining / unitSeconds.h);
  remaining -= hours * unitSeconds.h;
  const minutes = Math.floor(remaining / unitSeconds.m);
  remaining -= minutes * unitSeconds.m;

  return `${sign}${[
    days ? `${days}d` : null,
    hours ? `${hours}h` : null,
    minutes ? `${minutes}m` : null,
    remaining ? `${remaining}s` : null,
  ]
    .filter(Boolean)
    .join('')}`;
}

export function parseDurationSeconds(raw: string) {
  const input = raw.trim().toLowerCase();
  if (!input) return null;

  const numericSeconds = parseNumericSeconds(input);
  if (numericSeconds !== null) return numericSeconds;

  const isoSeconds = parseIsoDuration(input);
  if (isoSeconds !== null) return isoSeconds;

  const colonSeconds = parseColonDuration(input);
  if (colonSeconds !== null) return colonSeconds;

  const unitSeconds = parseUnitDuration(input);
  if (unitSeconds !== null) return unitSeconds;

  return null;
}

function parseNumericSeconds(input: string) {
  const value = Number(input);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function parseIsoDuration(input: string) {
  const normalizedInput = input.replace(/^pt(?=.*d)/, 'p');
  const match = normalizedInput.match(
    /^p(?:(\d+(?:\.\d+)?)w)?(?:(\d+(?:\.\d+)?)d)?(?:t(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?)?$/,
  );
  if (!match) return null;
  const [, weeks, days, hours, minutes, seconds] = match;
  return cleanSeconds(
    value(weeks) * unitSeconds.w +
      value(days) * unitSeconds.d +
      value(hours) * unitSeconds.h +
      value(minutes) * unitSeconds.m +
      value(seconds),
  );
}

function parseColonDuration(input: string) {
  if (!/^\d+(?::\d{1,2}){1,2}$/.test(input)) return null;
  const parts = input.split(':').map(Number);
  if (parts.some((part) => !Number.isInteger(part))) return null;
  if (parts.length === 2) {
    const [minutes = 0, seconds = 0] = parts;
    if (seconds >= 60) return null;
    return minutes * unitSeconds.m + seconds;
  }
  const [hours = 0, minutes = 0, seconds = 0] = parts;
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * unitSeconds.h + minutes * unitSeconds.m + seconds;
}

function parseUnitDuration(input: string) {
  const compact = input.replace(/,/g, ' ');
  const tokenPattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let cursor = 0;
  let matched = false;

  for (const match of compact.matchAll(tokenPattern)) {
    const gap = compact.slice(cursor, match.index).trim();
    if (gap) return null;
    const [, amountRaw = '', unitRaw = ''] = match;
    const unit = unitRaw as keyof typeof unitSeconds;
    const multiplier = unitSeconds[unit];
    if (!multiplier) return null;
    total += Number(amountRaw) * multiplier;
    cursor = (match.index ?? 0) + match[0].length;
    matched = true;
  }

  if (!matched || compact.slice(cursor).trim()) return null;
  return cleanSeconds(total);
}

function value(raw: string | undefined) {
  return raw ? Number(raw) : 0;
}

function cleanSeconds(value: number) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Number.isInteger(value) ? value : null;
}
