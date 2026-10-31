/**
 * Server-only configuration. Nothing in this module is safe to import from a
 * client component, and no value here is ever prefixed with NEXT_PUBLIC_.
 */

/** Verified OpenAI-compatible Tinker endpoint. Never derived from user input. */
export const TINKER_CHAT_COMPLETIONS_URL =
  'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions';

/**
 * Tinker sampling checkpoints look like:
 *   tinker://<run-id>/sampler_weights/<checkpoint-name>
 *
 * Run IDs can contain colons, for example:
 *   tinker://0034d8c9-0a88-52a9-b2b7-bce7cb1e6fef:train:0/sampler_weights/000080
 *
 * Raw base-model identifiers (for example "meta-llama/Llama-3.1-8B") are not
 * sampler checkpoints and are deliberately rejected.
 */
export const TINKER_MODEL_PATH_PATTERN =
  /^tinker:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\/sampler_weights\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const FORBIDDEN_SECRET_TEXT = /[\s\u0000-\u001F\u007F-\u009F]/;

export type ConfigFailureReason =
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'missing_model_path'
  | 'invalid_model_path';

export interface TinkerConfig {
  apiKey: string;
  modelPath: string;
}

export type ConfigResult =
  | { ok: true; config: TinkerConfig }
  | { ok: false; reason: ConfigFailureReason };

export type EnvRecord = Record<string, string | undefined>;

export function isValidTinkerModelPath(value: string): boolean {
  return (
    value.length <= 260 &&
    !value.includes('..') &&
    TINKER_MODEL_PATH_PATTERN.test(value)
  );
}

export function readDirectorConfig(env: EnvRecord): ConfigResult {
  const apiKey = env.TINKER_API_KEY?.trim() ?? '';
  if (!apiKey) return { ok: false, reason: 'missing_api_key' };
  if (
    apiKey.length < 8 ||
    apiKey.length > 512 ||
    FORBIDDEN_SECRET_TEXT.test(apiKey)
  ) {
    return { ok: false, reason: 'invalid_api_key' };
  }

  const modelPath = env.TINKER_MODEL_PATH?.trim() ?? '';
  if (!modelPath) return { ok: false, reason: 'missing_model_path' };
  if (!isValidTinkerModelPath(modelPath)) {
    return { ok: false, reason: 'invalid_model_path' };
  }

  return { ok: true, config: { apiKey, modelPath } };
}
