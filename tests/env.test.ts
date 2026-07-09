import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const managedKeys = [
  'DEFAULT_TEXT_PRIMARY_PROVIDER',
  'DEFAULT_TEXT_PRIMARY_MODEL',
  'DEFAULT_IMAGE_PRIMARY_PROVIDER',
  'DEFAULT_IMAGE_PRIMARY_MODEL',
  'ADDITIONAL_TEXT_SIGNAL_PROVIDER',
  'ADDITIONAL_TEXT_SIGNAL_MODELS',
  'ADDITIONAL_IMAGE_SIGNAL_PROVIDER',
  'ADDITIONAL_IMAGE_SIGNAL_MODELS',
  'DEFAULT_TEXT_EMBEDDINGS_PROVIDER',
  'DEFAULT_TEXT_EMBEDDINGS_MODEL',
  'DEFAULT_IMAGE_EMBEDDINGS_PROVIDER',
  'DEFAULT_IMAGE_EMBEDDINGS_MODEL',
  'DEFAULT_EMBEDDINGS_DIMENSIONS',
  'MODEL_CALL_LIMIT',
  'MODEL_RETRY_INITIAL_DELAY_MS',
  'MODEL_RETRY_MAX_DELAY_MS',
  'GLOBAL_AUTH_MODE',
  'HONEYBOT_DEFAULT_CROSSCHANNEL_MINIMUM_WINDOW_SECONDS',
  'HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_SECONDS',
  'HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_STEEPNESS',
  'HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_MIDPOINT_CHANNELS',
  'HONEYBOT_DEFAULT_CROSSCHANNEL_CHANNEL_THRESHOLD',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  vi.resetModules();
  process.env.DOTENV_CONFIG_PATH = '/tmp/honeybot-test-no-env';
  process.env.DISCORD_TOKEN = 'test-token';
  for (const key of managedKeys) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of managedKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe('environment defaults', () => {
  it('matches the documented .env.example model and capacity defaults', async () => {
    const { env } = await import('../src/env.js');

    expect(env.DEFAULT_TEXT_PRIMARY_PROVIDER).toBe('openrouter');
    expect(env.DEFAULT_TEXT_PRIMARY_MODEL).toBe('google/gemma-4-31b-it');
    expect(env.DEFAULT_IMAGE_PRIMARY_PROVIDER).toBe('openrouter');
    expect(env.DEFAULT_IMAGE_PRIMARY_MODEL).toBe('google/gemma-4-31b-it');
    expect(env.ADDITIONAL_TEXT_SIGNAL_PROVIDER).toBe('openrouter');
    expect(env.ADDITIONAL_TEXT_SIGNAL_MODELS).toEqual([]);
    expect(env.ADDITIONAL_IMAGE_SIGNAL_PROVIDER).toBe('openrouter');
    expect(env.ADDITIONAL_IMAGE_SIGNAL_MODELS).toEqual([]);
    expect(env.DEFAULT_TEXT_EMBEDDINGS_PROVIDER).toBe('openrouter');
    expect(env.DEFAULT_TEXT_EMBEDDINGS_MODEL).toBe(
      'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    );
    expect(env.DEFAULT_IMAGE_EMBEDDINGS_PROVIDER).toBe('openrouter');
    expect(env.DEFAULT_IMAGE_EMBEDDINGS_MODEL).toBe(
      'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    );
    expect(env.DEFAULT_EMBEDDINGS_DIMENSIONS).toBe(2048);
    expect(env.MODEL_CALL_LIMIT).toBe(6000);
    expect(env.MODEL_RETRY_INITIAL_DELAY_MS).toBe(300);
    expect(env.MODEL_RETRY_MAX_DELAY_MS).toBe(15_000);
    expect(env.GLOBAL_AUTH_MODE).toBe('team');
  });

  it('uses the curve-based cross-channel deployment defaults', async () => {
    const { deploymentGuildDefaults } = await import('../src/env.js');

    expect(deploymentGuildDefaults.crosschannelMinimumWindowSeconds).toBe(5);
    expect(deploymentGuildDefaults.crosschannelWindowSeconds).toBe(3600);
    expect(deploymentGuildDefaults.crosschannelWindowSteepness).toBe(0.49);
    expect(deploymentGuildDefaults.crosschannelWindowMidpointChannels).toBe(13);
    expect(deploymentGuildDefaults.crosschannelChannelThreshold).toBe(2);
  });
});
