import { env } from './env.js';

const levels = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof levels)[number];

const minimumLevel = levels.indexOf(env.LOG_LEVEL);

function shouldLog(level: LogLevel) {
  return levels.indexOf(level) >= minimumLevel;
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>) {
  if (!shouldLog(level)) return;

  const suffix = context ? ` ${JSON.stringify(context)}` : '';
  console[level](`[${level}] ${message}${suffix}`);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => write('error', message, context),
};
