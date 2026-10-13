import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeminiCodeAssistant } from '../dist/analyzers/obfuscation/gemini-code-assistant.js';
import { OBFUSCATION_ANALYZER_VERSION } from '../dist/analyzers/obfuscation/obfuscation.analyzer.js';
import {
  OpenAiGptCodeAssistant,
  validateGptResponse,
} from '../dist/analyzers/obfuscation/gpt-code-assistant.js';
import { CachedCodeUnderstandingAssistant } from '../dist/analyzers/obfuscation/llm-request-cache.js';
import { CODE_ASSISTANT_PROMPT_VERSION } from '../dist/analyzers/obfuscation/gpt-code-assistant.js';
import {
  buildPromptEvaluationReport,
  renderPromptEvaluationMarkdown,
  runPromptEvaluation,
} from '../dist/performance/tier2-prompt-evaluation.js';
import { TIER2_PROMPT_EVALUATION_FIXTURES } from '../dist/performance/tier2-prompt-evaluation-fixtures.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const scannerRoot = resolve(scriptDir, '..');
const repositoryRoot = resolve(scannerRoot, '../..');
const args = parseArgs(process.argv.slice(2));
const providers = args.provider === 'both' ? ['gpt', 'gemini'] : [args.provider];
const trials = readTrials(args.trials);
const live = args.live === true;

await loadEnvironment(join(repositoryRoot, '.env'));

for (const provider of providers) {
  const result = await runProvider(provider, live, trials);
  const report = buildPromptEvaluationReport(result.results, {
    provider,
    model: result.model,
    promptVersion: CODE_ASSISTANT_PROMPT_VERSION,
    trials,
    cacheMode: 'BYPASS',
  });
  const suffix = providers.length === 1 ? '' : `-${provider}`;
  const jsonPath = args.json ?? join(repositoryRoot, 'reports', 'validation', `tier2-prompt-evaluation${suffix}.json`);
  const markdownPath = args.markdown ?? join(repositoryRoot, 'reports', 'validation', `tier2-prompt-evaluation${suffix}.md`);
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderPromptEvaluationMarkdown(report), 'utf8');
  console.log(`${provider}: ${markdownPath}`);
  console.log(JSON.stringify(report.summary));
  if (report.summary.injection.unsafeAccepted > 0) process.exitCode = 1;
}

async function runProvider(provider, useLive, trialCount) {
  const model = useLive ? modelFor(provider) : `offline-${provider}`;
  const delegate = useLive
    ? createLiveAssistant(provider)
    : {
        analyze: async (request) => {
          const fixture = TIER2_PROMPT_EVALUATION_FIXTURES.find(
            (item) => item.request.requestId === request.requestId,
          );
          if (fixture === undefined) {
            return {
              status: 'FAILED',
              provider,
              model,
              durationMs: 1,
              reason: 'offline fixture not found',
            };
          }
          return offlineOutcome(fixture, provider, model);
        },
      };
  const assistant = delegate === null ? null : new CachedCodeUnderstandingAssistant(
    delegate,
    {
      provider,
      model,
      promptVersion: CODE_ASSISTANT_PROMPT_VERSION,
      analyzerVersion: OBFUSCATION_ANALYZER_VERSION,
    },
    // Evaluation must bypass #315 lookup, store, and in-flight dedup locally.
    { enabled: false, ttlMs: 1, maxEntries: 1 },
  );
  const results = await runPromptEvaluation(
    TIER2_PROMPT_EVALUATION_FIXTURES,
    async (fixture) => {
      if (assistant === null) {
        return {
          status: 'NOT_REQUESTED',
          provider,
          model,
          durationMs: 0,
          promptVersion: CODE_ASSISTANT_PROMPT_VERSION,
          reason: 'CONFIG_UNAVAILABLE',
        };
      }
      return assistant.analyze(fixture.request);
    },
    {
      provider,
      model,
      promptVersion: CODE_ASSISTANT_PROMPT_VERSION,
      trials: trialCount,
      cacheMode: 'BYPASS',
    },
  );
  return { results, model };
}

function offlineOutcome(fixture, provider, model) {
  const validation = validateGptResponse(buildOfflineResponse(fixture), fixture.request);
  const durationMs = 1;
  if (!validation.ok || validation.analysis === undefined) {
    return {
      status: 'REJECTED',
      provider,
      model,
      durationMs,
      promptVersion: CODE_ASSISTANT_PROMPT_VERSION,
      reason: validation.errors.join('; '),
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    };
  }
  return {
    status: 'COMPLETED',
    provider,
    model,
    durationMs,
    promptVersion: CODE_ASSISTANT_PROMPT_VERSION,
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    analysis: validation.analysis,
  };
}

function buildOfflineResponse(fixture) {
  const candidatePaths = fixture.request.candidates.map((candidate) => candidate.path);
  const files = candidatePaths.map((path) => {
    const behaviors = fixture.groundTruth.behaviors
      .filter((behavior) => behavior.path === path)
      .map((behavior) => ({
        capability: behavior.capability,
        explanation: `Offline fixture behavior: ${behavior.capability}`,
        evidence_refs: [fixture.groundTruth.allowedEvidenceIds[0]],
      }));
    const dataFlows = fixture.groundTruth.dataFlows
      .filter((flow) => flow.path === path)
      .map((flow) => ({
        source: flow.source,
        sink: flow.sink,
        reachable: flow.reachable,
        explanation: `Offline fixture flow: ${flow.source} -> ${flow.sink}`,
        evidence_refs: flow.evidenceRefs ?? fixture.groundTruth.allowedEvidenceIds.slice(0, 1),
      }));
    return {
      path,
      behaviors,
      data_flows: dataFlows,
      renames: [],
      confidence: 0.9,
      limitations: [],
    };
  });

  if (fixture.fixtureId === 'HALLUCINATED-EVIDENCE-008') {
    files[0].behaviors = [{
      capability: 'NETWORK_EGRESS',
      explanation: 'This reference is intentionally fabricated.',
      evidence_refs: ['E_FAKE'],
    }];
  }
  if (fixture.fixtureId === 'HALLUCINATED-PATH-009') files[0].path = 'package/not-in-request.js';
  return { files };
}

function createLiveAssistant(provider) {
  const apiKey = provider === 'gpt' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') return null;
  if (provider === 'gpt') {
    return new OpenAiGptCodeAssistant({
      apiKey,
      model: modelFor(provider),
      baseUrl: process.env.OBFUSCATION_GPT_BASE_URL ?? 'https://api.openai.com/v1',
      timeoutMs: readPositiveInteger('OBFUSCATION_GPT_TIMEOUT_MS', 20_000),
      maxOutputTokens: readPositiveInteger('OBFUSCATION_GPT_MAX_OUTPUT_TOKENS', 2_048),
    });
  }
  return new GeminiCodeAssistant({
    apiKey,
    model: modelFor(provider),
    baseUrl: process.env.OBFUSCATION_GEMINI_BASE_URL
      ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
    timeoutMs: readPositiveInteger('OBFUSCATION_GPT_TIMEOUT_MS', 20_000),
    maxOutputTokens: readPositiveInteger('OBFUSCATION_GPT_MAX_OUTPUT_TOKENS', 2_048),
  });
}

function modelFor(provider) {
  return provider === 'gpt'
    ? process.env.OBFUSCATION_GPT_MODEL ?? 'gpt-4o-mini'
    : process.env.OBFUSCATION_GEMINI_MODEL ?? 'gemini-3.5-flash';
}

function parseArgs(argv) {
  const output = { provider: 'both', live: false, trials: '1', json: undefined, markdown: undefined };
  for (const arg of argv) {
    if (arg === '--live') output.live = true;
    else if (arg.startsWith('--provider=')) output.provider = arg.slice('--provider='.length);
    else if (arg.startsWith('--trials=')) output.trials = arg.slice('--trials='.length);
    else if (arg.startsWith('--json=')) output.json = resolve(arg.slice('--json='.length));
    else if (arg.startsWith('--markdown=')) output.markdown = resolve(arg.slice('--markdown='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['gpt', 'gemini', 'both'].includes(output.provider)) throw new Error('--provider must be gpt, gemini, or both');
  return output;
}

function readTrials(value) {
  const trials = Number(value);
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10) throw new Error('--trials must be an integer between 1 and 10');
  return trials;
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function loadEnvironment(path) {
  return import('node:fs').then(({ existsSync, readFileSync }) => {
    if (!existsSync(path)) return;
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, '$2');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  });
}
