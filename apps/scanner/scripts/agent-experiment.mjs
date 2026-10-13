import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentExperimentService, redact } from '../dist/application/agent-experiment/agent-experiment.service.js';
import { AgentExperimentOpenAiProvider } from '../dist/application/agent-experiment/agent-experiment-openai.provider.js';
import { loadLlmAgentEnvironment } from '../dist/config/scanner-environment.js';

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = parseArgs(argv);
  let output;
  try {
    const input = JSON.parse(await readFile(resolve(args.input), 'utf8'));
    let provider;
    let apiKey;
    if (args.live) {
      apiKey = environment.OPENAI_API_KEY;
      if (apiKey?.trim() && environment.LLM_AGENT_MODEL?.trim()) {
        const config = loadLlmAgentEnvironment({ ...environment, LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS',
          LLM_AGENT_MAX_RETRIES: '0', LLM_AGENT_TIMEOUT_MS: String(args.timeoutMs) });
        provider = new AgentExperimentOpenAiProvider(config, args.reasoningEffort);
      }
    }
    output = await new AgentExperimentService(undefined, provider).execute(input, {
      live: args.live, timeoutMs: args.timeoutMs, maxRetries: 0, model: environment.LLM_AGENT_MODEL ?? '', reasoningEffort: args.reasoningEffort,
    }, apiKey);
  } catch (error) {
    output = { contractVersion: '1.1.0', executionMode: args.live ? 'LIVE' : 'DRY_RUN', status: 'FAILED',
      responseValidation: 'FAIL', analysisOutcome: 'UNAVAILABLE', toolDisposition: 'UNAVAILABLE', additionalModelRounds: 0,
      outcomeDetailCode: null, validationFailures: [], error: { code: 'CLI_INPUT_FAILED', message: redact(error instanceof Error ? error.message : String(error)) } };
    process.exitCode = 1;
  }
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.output === '-') process.stdout.write(serialized);
  else await atomicWrite(resolve(args.output), serialized);
  if (output.status === 'FAILED' || output.status === 'TIMEOUT') process.exitCode = 1;
  return output;
}

export function parseArgs(argv) {
  const result = { input: undefined, output: '-', timeoutMs: 10_000, maxRetries: 0, live: false, reasoningEffort: 'medium' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--live') { if (seen.has(key)) throw new Error('DUPLICATE_OPTION:--live'); seen.add(key); result.live = true; continue; }
    if (!['--input', '--output', '--timeout-ms', '--max-retries', '--reasoning-effort'].includes(key)) throw new Error(`UNKNOWN_OPTION:${key}`);
    if (seen.has(key)) throw new Error(`DUPLICATE_OPTION:${key}`); seen.add(key);
    const value = argv[++index]; if (!value) throw new Error(`MISSING_OPTION_VALUE:${key}`);
    if (key === '--input') result.input = value;
    else if (key === '--output') result.output = value;
    else if (key === '--timeout-ms') result.timeoutMs = number(value, 'timeout');
    else if (key === '--max-retries') result.maxRetries = number(value, 'retries');
    else { if (value !== 'medium') throw new Error('AGENT_EXPERIMENT_REASONING_EFFORT_UNSUPPORTED'); result.reasoningEffort = value; }
  }
  if (!result.input) throw new Error('MISSING_REQUIRED_OPTION:--input');
  if (result.maxRetries !== 0) throw new Error('EXPERIMENT_RETRY_MUST_BE_ZERO');
  return result;
}
function number(value, name) { if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error(`INVALID_${name.toUpperCase()}`); const parsed=Number(value); if (!Number.isSafeInteger(parsed) || (name==='timeout'&&parsed===0)) throw new Error(`INVALID_${name.toUpperCase()}`); return parsed; }
async function atomicWrite(file, content) { await mkdir(dirname(file), { recursive: true }); const partial=`${file}.partial`; await writeFile(partial, content, { flag: 'wx' }); await rename(partial, file); }

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
