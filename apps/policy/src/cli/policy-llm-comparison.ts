import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ClaudePolicyLlmProvider } from '../llm/claude-policy-llm.provider';
import { OpenAiPolicyLlmProvider } from '../llm/policy-llm.provider';
import { PolicyLlmComparisonFixtureProvider } from '../evaluation/policy-llm-comparison.fixture-provider';
import { buildPolicyLlmComparisonFixtures } from '../evaluation/policy-llm-comparison.fixtures';
import {
  renderPolicyLlmComparisonCsv,
  runPolicyLlmComparison,
  type HarnessProvider,
  type PricingConfig,
} from '../evaluation/policy-llm-comparison.harness';
import { writePolicyLlmComparisonOutputs } from './policy-llm-comparison.output';

const repositoryRoot = resolve(__dirname, '../../..');
const args = parseArgs(process.argv.slice(2));
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Policy LLM comparison failed');
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await loadEnvironment(resolve(repositoryRoot, '.env'));
  const providers = createProviders(args.live, args.provider);
  const pricing = await loadPricing(args.pricing);
  if (args.live) validateLiveConfiguration(args.provider, providers, pricing);
  const report = await runPolicyLlmComparison(buildPolicyLlmComparisonFixtures(), {
    mode: args.live ? 'live' : 'fixture',
    providers,
    timeoutMs: positiveInteger(process.env.POLICY_LLM_HARNESS_TIMEOUT_MS, 20_000),
    pricing,
  });
  await writePolicyLlmComparisonOutputs(
    { path: args.json, content: JSON.stringify(report, null, 2) },
    args.csv ? { path: args.csv, content: renderPolicyLlmComparisonCsv(report) } : undefined,
  );
  console.log(JSON.stringify({ mode: report.mode, json: args.json, csv: args.csv, providers: report.providers }));
}

function createProviders(live: boolean, selection: 'both' | 'gpt' | 'claude'): Record<string, HarnessProvider | undefined> {
  const selected = selection === 'both' ? ['gpt', 'claude'] : [selection];
  const result: Record<string, HarnessProvider | undefined> = { gpt: undefined, claude: undefined };
  if (!live) {
    for (const provider of selected) {
      const model = `offline-${provider}`;
      result[provider] = { provider: new PolicyLlmComparisonFixtureProvider(model), model };
    }
    return result;
  }
  if (selected.includes('gpt') && process.env.OPENAI_API_KEY?.trim()) {
    const model = process.env.POLICY_LLM_HARNESS_GPT_MODEL ?? process.env.POLICY_LLM_MODEL ?? 'gpt-4.1-mini';
    result.gpt = { provider: new OpenAiPolicyLlmProvider({ apiKey: process.env.OPENAI_API_KEY, model, baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com' }), model };
  }
  if (selected.includes('claude') && process.env.ANTHROPIC_API_KEY?.trim()) {
    const model = process.env.POLICY_LLM_HARNESS_CLAUDE_MODEL ?? 'claude-sonnet-4-5';
    result.claude = { provider: new ClaudePolicyLlmProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model,
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
      apiVersion: process.env.ANTHROPIC_API_VERSION,
      maxOutputTokens: positiveInteger(process.env.POLICY_LLM_HARNESS_MAX_OUTPUT_TOKENS, 4096),
    }), model };
  }
  return result;
}

async function loadPricing(path: string | undefined): Promise<PricingConfig[] | undefined> {
  const source = path ? await readFile(resolve(path), 'utf8') : process.env.POLICY_LLM_PRICING_JSON;
  if (!source) return undefined;
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed)) throw new Error('POLICY_LLM_PRICING_MUST_BE_ARRAY');
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('POLICY_LLM_PRICING_INVALID_ENTRY');
    const config = item as Partial<PricingConfig>;
    if ((config.provider !== 'gpt' && config.provider !== 'claude') || typeof config.model !== 'string' || !config.model.trim()
      || typeof config.currency !== 'string' || !config.currency.trim()
      || !Number.isFinite(config.inputCostPerToken) || config.inputCostPerToken! < 0
      || !Number.isFinite(config.outputCostPerToken) || config.outputCostPerToken! < 0
      || !Number.isFinite(config.tokenUnit) || config.tokenUnit! <= 0
      || (config.cachedInputCostPerToken !== undefined && (!Number.isFinite(config.cachedInputCostPerToken) || config.cachedInputCostPerToken < 0))) {
      throw new Error('POLICY_LLM_PRICING_INVALID_ENTRY');
    }
  }
  return parsed as PricingConfig[];
}

function validateLiveConfiguration(selection: 'both' | 'gpt' | 'claude', providers: Record<string, HarnessProvider | undefined>, pricing: PricingConfig[] | undefined): void {
  const selected = selection === 'both' ? ['gpt', 'claude'] : [selection];
  for (const provider of selected) {
    if (!providers[provider]) throw new Error(provider === 'gpt' ? 'POLICY_LLM_HARNESS_OPENAI_API_KEY_REQUIRED' : 'POLICY_LLM_HARNESS_ANTHROPIC_API_KEY_REQUIRED');
    if (!providers[provider]?.model.trim()) throw new Error(`POLICY_LLM_HARNESS_${provider.toUpperCase()}_MODEL_REQUIRED`);
  }
  for (const item of pricing ?? []) if (item.provider !== 'gpt' && item.provider !== 'claude') throw new Error('POLICY_LLM_PRICING_INVALID_PROVIDER');
}

function parseArgs(argv: string[]): { provider: 'both' | 'gpt' | 'claude'; live: boolean; json: string; csv?: string; pricing?: string } {
  const result: { provider: 'both' | 'gpt' | 'claude'; live: boolean; json: string; csv?: string; pricing?: string } = {
    provider: 'both', live: false, json: resolve(repositoryRoot, 'reports/validation/policy-llm-comparison.json'),
  };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--live') result.live = true;
    else if (arg.startsWith('--provider=')) result.provider = parseProvider(arg.slice('--provider='.length));
    else if (arg.startsWith('--json=')) result.json = resolve(arg.slice('--json='.length));
    else if (arg.startsWith('--csv=')) result.csv = resolve(arg.slice('--csv='.length));
    else if (arg.startsWith('--pricing=')) result.pricing = arg.slice('--pricing='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function parseProvider(value: string): 'both' | 'gpt' | 'claude' {
  if (value === 'both' || value === 'gpt' || value === 'claude') return value;
  throw new Error('--provider must be both, gpt, or claude');
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Policy LLM harness integer setting must be positive');
  return parsed;
}

async function loadEnvironment(path: string): Promise<void> {
  try {
    const source = await readFile(path, 'utf8');
    for (const rawLine of source.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, '$2');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
