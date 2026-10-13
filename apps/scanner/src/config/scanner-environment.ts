import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_METADATA_TIMEOUT_MS = 10_000;
export const DEFAULT_METADATA_MAX_RESPONSE_BYTES = 2_097_152;
export const DEFAULT_TARBALL_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_TARBALL_DOWNLOAD_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_TARBALL_BYTES = 104_857_600;
export const DEFAULT_TARBALL_MAX_REDIRECTS = 3;
export const DEFAULT_GUARDDOG_TIMEOUT_MS = 60_000;
export const DEFAULT_CUSTOM_RULE_TIMEOUT_MS = 30_000;
export const DEFAULT_GUARDDOG_KILL_GRACE_MS = 3_000;
export const DEFAULT_GUARDDOG_MAX_OUTPUT_BYTES = 10_485_760;
export const DEFAULT_POLICY_URL = 'http://policy:8000';
export const DEFAULT_POLICY_TIMEOUT_MS = 30_000;
export const DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS = 240_000;
export const DEFAULT_OBFUSCATION_GPT_MODEL = 'gpt-4o-mini';
export const DEFAULT_OBFUSCATION_GPT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OBFUSCATION_GPT_TIMEOUT_MS = 20_000;
export const DEFAULT_OBFUSCATION_GPT_MAX_OUTPUT_TOKENS = 2_048;
export const DEFAULT_OBFUSCATION_LLM_CACHE_ENABLED = true;
export const DEFAULT_OBFUSCATION_LLM_CACHE_TTL_MS = 300_000;
export const DEFAULT_OBFUSCATION_LLM_CACHE_MAX_ENTRIES = 256;
export const DEFAULT_OBFUSCATION_GEMINI_MODEL = 'gemini-3.5-flash';
export const DEFAULT_OBFUSCATION_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

function nonEmptyStringEnvironmentValue(
  variableName: string,
  defaultValue: string,
): z.ZodType<string, string | undefined> {
  return z.string().default(defaultValue).refine((value) => value.trim() !== '', {
    message: `${variableName} must be a non-empty string`,
  });
}

function positiveIntegerEnvironmentValue(
  variableName: string,
  defaultValue: number,
): z.ZodType<number, string | undefined> {
  return z
    .string()
    .default(String(defaultValue))
    .refine((value) => /^[1-9]\d*$/.test(value), {
      message: `${variableName} must be a positive integer`,
    })
    .transform(Number)
    .refine(Number.isSafeInteger, {
      message: `${variableName} must be a safe integer`,
    });
}

export const scannerEnvironmentSchema = z.object({
  POLICY_URL: nonEmptyStringEnvironmentValue('POLICY_URL', DEFAULT_POLICY_URL),
  POLICY_TIMEOUT_MS: positiveIntegerEnvironmentValue(
    'POLICY_TIMEOUT_MS',
    DEFAULT_POLICY_TIMEOUT_MS,
  ),
  SCANNER_PACKAGE_TIMEOUT_MS: positiveIntegerEnvironmentValue(
    'SCANNER_PACKAGE_TIMEOUT_MS',
    DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS,
  ),
  // 기본값은 외부 전송이 없는 off다. shadow는 Policy 판정에 영향을 주지 않는다.
  OBFUSCATION_GPT_MODE: z.enum(['off', 'shadow']).default('off'),
  METADATA_TIMEOUT_MS: positiveIntegerEnvironmentValue(
    'METADATA_TIMEOUT_MS',
    DEFAULT_METADATA_TIMEOUT_MS,
  ),
  METADATA_MAX_RESPONSE_BYTES: positiveIntegerEnvironmentValue(
    'METADATA_MAX_RESPONSE_BYTES',
    DEFAULT_METADATA_MAX_RESPONSE_BYTES,
  ),
  TARBALL_CONNECT_TIMEOUT_MS: positiveIntegerEnvironmentValue(
    'TARBALL_CONNECT_TIMEOUT_MS',
    DEFAULT_TARBALL_CONNECT_TIMEOUT_MS,
  ),
  TARBALL_DOWNLOAD_TIMEOUT_MS: positiveIntegerEnvironmentValue(
    'TARBALL_DOWNLOAD_TIMEOUT_MS',
    DEFAULT_TARBALL_DOWNLOAD_TIMEOUT_MS,
  ),
  MAX_TARBALL_BYTES: positiveIntegerEnvironmentValue(
    'MAX_TARBALL_BYTES',
    DEFAULT_MAX_TARBALL_BYTES,
  ),
  TARBALL_MAX_REDIRECTS: positiveIntegerEnvironmentValue(
    'TARBALL_MAX_REDIRECTS',
    DEFAULT_TARBALL_MAX_REDIRECTS,
  ),
});

export const llmAgentEnvironmentSchema = z.object({
  LLM_AGENT_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  LLM_AGENT_TRIGGER_MODE: z.enum(['DISABLED', 'ALWAYS', 'RISK_BASED']).default('DISABLED'),
  LLM_AGENT_MAX_TOOL_CALLS: positiveIntegerEnvironmentValue('LLM_AGENT_MAX_TOOL_CALLS', 4),
  LLM_AGENT_MAX_ADDITIONAL_CODE_REQUESTS: positiveIntegerEnvironmentValue('LLM_AGENT_MAX_ADDITIONAL_CODE_REQUESTS', 2),
  LLM_AGENT_MAX_INITIAL_SLICES: positiveIntegerEnvironmentValue('LLM_AGENT_MAX_INITIAL_SLICES', 10),
  LLM_AGENT_MAX_LINES_PER_SLICE: positiveIntegerEnvironmentValue('LLM_AGENT_MAX_LINES_PER_SLICE', 120),
  LLM_AGENT_MAX_INITIAL_CODE_LINES: positiveIntegerEnvironmentValue('LLM_AGENT_MAX_INITIAL_CODE_LINES', 800),
  LLM_AGENT_MAX_TOTAL_CODE_LINES: positiveIntegerEnvironmentValue('LLM_AGENT_MAX_TOTAL_CODE_LINES', 1600),
  LLM_AGENT_MAX_FILE_SIZE_BYTES: positiveIntegerEnvironmentValue('LLM_AGENT_MAX_FILE_SIZE_BYTES', 1048576),
  LLM_AGENT_INPUT_SCHEMA_VERSION: z.string().trim().min(1).default('0.2.0'),
  LLM_AGENT_PROVIDER: z.enum(['openai']).default('openai'),
  LLM_AGENT_MODEL: z.string().trim().default(''),
  LLM_AGENT_TIMEOUT_MS: positiveIntegerEnvironmentValue('LLM_AGENT_TIMEOUT_MS', 180_000),
  LLM_AGENT_MAX_RETRIES: z.string().regex(/^(0|[1-9]\d*)$/u).default('1').transform(Number).refine(Number.isSafeInteger),
  LLM_AGENT_PROMPT_VERSION: z.literal('scanner-single-agent-0.1.0').default('scanner-single-agent-0.1.0'),
  LLM_AGENT_OUTPUT_SCHEMA_VERSION: z.literal('0.1.0').default('0.1.0'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com'),
  // On by default. It only runs when Tier 3 runs, and without TYPESAFE_API_KEY the check is skipped (recorded as UNAVAILABLE) and Tier 3 goes on.
  LLM_AGENT_CONTEXT_CHECK_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  LLM_AGENT_CONTEXT_CHECK_MODEL: z.string().trim().min(1).default('jev-latest'),
  LLM_AGENT_CONTEXT_CHECK_TIMEOUT_MS: positiveIntegerEnvironmentValue('LLM_AGENT_CONTEXT_CHECK_TIMEOUT_MS', 3_000),
  // On by default: the check asks once more about the groups it added code for, one more call per such group.
  LLM_AGENT_CONTEXT_RECHECK_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_BASE_URL: z.url().default('https://api.typesafe.ai'),
}).superRefine((value, ctx) => {
  if (value.LLM_AGENT_MAX_INITIAL_CODE_LINES > value.LLM_AGENT_MAX_TOTAL_CODE_LINES) ctx.addIssue({ code: 'custom', message: 'Initial code line limit exceeds total line limit' });
  if (value.LLM_AGENT_ENABLED && value.LLM_AGENT_TRIGGER_MODE !== 'DISABLED' && !value.LLM_AGENT_MODEL) ctx.addIssue({ code: 'custom', message: 'LLM_AGENT_MODEL is required when Agent is active' });
  if (value.LLM_AGENT_ENABLED && value.LLM_AGENT_TRIGGER_MODE !== 'DISABLED' && !value.OPENAI_API_KEY?.trim()) ctx.addIssue({ code: 'custom', message: 'OPENAI_API_KEY is required when Agent is active' });
});
export type LlmAgentEnvironment = z.infer<typeof llmAgentEnvironmentSchema>;
export function loadLlmAgentEnvironment(environment: NodeJS.ProcessEnv = process.env): LlmAgentEnvironment {
  return llmAgentEnvironmentSchema.parse(environment);
}

export type ScannerEnvironment = z.infer<typeof scannerEnvironmentSchema>;

export function loadScannerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ScannerEnvironment {
  return scannerEnvironmentSchema.parse(environment);
}

export const obfuscationGptEnvironmentSchema = z.object({
  OBFUSCATION_GPT_MODE: z.enum(['off', 'shadow']).default('off'),
  // Tier 2 코드 이해 보조 제공자. 기본값은 GPT이며 Gemini는 별도 키·모델·주소를 사용한다.
  OBFUSCATION_LLM_PROVIDER: z.enum(['gpt', 'gemini']).default('gpt'),
  OPENAI_API_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().trim().min(1).optional(),
  ),
  GEMINI_API_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().trim().min(1).optional(),
  ),
  OBFUSCATION_GEMINI_MODEL: nonEmptyStringEnvironmentValue(
    'OBFUSCATION_GEMINI_MODEL',
    DEFAULT_OBFUSCATION_GEMINI_MODEL,
  ),
  OBFUSCATION_GEMINI_BASE_URL: z.string().url().default(DEFAULT_OBFUSCATION_GEMINI_BASE_URL),
  OBFUSCATION_GPT_MODEL: nonEmptyStringEnvironmentValue(
    'OBFUSCATION_GPT_MODEL',
    DEFAULT_OBFUSCATION_GPT_MODEL,
  ),
  OBFUSCATION_GPT_BASE_URL: z.string().url().default(DEFAULT_OBFUSCATION_GPT_BASE_URL),
  OBFUSCATION_GPT_TIMEOUT_MS: positiveIntegerEnvironmentValue(
    'OBFUSCATION_GPT_TIMEOUT_MS',
    DEFAULT_OBFUSCATION_GPT_TIMEOUT_MS,
  ),
  OBFUSCATION_GPT_MAX_OUTPUT_TOKENS: positiveIntegerEnvironmentValue(
    'OBFUSCATION_GPT_MAX_OUTPUT_TOKENS',
    DEFAULT_OBFUSCATION_GPT_MAX_OUTPUT_TOKENS,
  ),
  OBFUSCATION_LLM_CACHE_ENABLED: z.enum(['true', 'false'])
    .default(DEFAULT_OBFUSCATION_LLM_CACHE_ENABLED ? 'true' : 'false')
    .transform((value) => value === 'true'),
  OBFUSCATION_LLM_CACHE_TTL_MS: positiveIntegerEnvironmentValue(
    'OBFUSCATION_LLM_CACHE_TTL_MS',
    DEFAULT_OBFUSCATION_LLM_CACHE_TTL_MS,
  ),
  OBFUSCATION_LLM_CACHE_MAX_ENTRIES: positiveIntegerEnvironmentValue(
    'OBFUSCATION_LLM_CACHE_MAX_ENTRIES',
    DEFAULT_OBFUSCATION_LLM_CACHE_MAX_ENTRIES,
  ),
}).superRefine((environment, context) => {
  if (environment.OBFUSCATION_GPT_MODE !== 'shadow') return;
  if (environment.OBFUSCATION_LLM_PROVIDER === 'gpt' && environment.OPENAI_API_KEY === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when OBFUSCATION_GPT_MODE=shadow and OBFUSCATION_LLM_PROVIDER=gpt',
    });
  }
  if (environment.OBFUSCATION_LLM_PROVIDER === 'gemini' && environment.GEMINI_API_KEY === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['GEMINI_API_KEY'],
      message: 'GEMINI_API_KEY is required when OBFUSCATION_GPT_MODE=shadow and OBFUSCATION_LLM_PROVIDER=gemini',
    });
  }
});

export type ObfuscationGptEnvironment = z.infer<typeof obfuscationGptEnvironmentSchema>;

export function loadObfuscationGptEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ObfuscationGptEnvironment {
  return obfuscationGptEnvironmentSchema.parse(environment);
}

export const guardDogEnvironmentSchema = z.object({
  GUARDDOG_BIN: z.string().trim().min(1).default('guarddog'),
  GUARDDOG_VERSION: z.string().trim().min(1).default('3.1.0'),
  GUARDDOG_TIMEOUT_MS: positiveIntegerEnvironmentValue(
    'GUARDDOG_TIMEOUT_MS',
    DEFAULT_GUARDDOG_TIMEOUT_MS,
  ),
  GUARDDOG_KILL_GRACE_MS: positiveIntegerEnvironmentValue(
    'GUARDDOG_KILL_GRACE_MS',
    DEFAULT_GUARDDOG_KILL_GRACE_MS,
  ),
  GUARDDOG_MAX_OUTPUT_BYTES: positiveIntegerEnvironmentValue(
    'GUARDDOG_MAX_OUTPUT_BYTES',
    DEFAULT_GUARDDOG_MAX_OUTPUT_BYTES,
  ),
  GUARDDOG_SANDBOX_MODE: z.enum(['REQUIRED', 'DISABLED']).default('REQUIRED'),
  SCANNER_TEMP_DIR: z.string().trim().min(1).default(join(tmpdir(), 'scanner')),
});

export type GuardDogEnvironment = z.infer<typeof guardDogEnvironmentSchema>;

export function loadGuardDogEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GuardDogEnvironment {
  return guardDogEnvironmentSchema.parse(environment);
}
