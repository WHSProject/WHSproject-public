import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { AGENT_PROMPT_VERSION_V0_3, buildAgentPromptV0_3 } from '../dist/llm-agent/artifact/agent-prompt-v0_3.js';
import { AGENT_OUTPUT_API_SCHEMA_V0_3 } from '../dist/llm-agent/artifact/agent-output-v0_3.api-schema.js';

const scannerRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(process.argv[2] ?? join(scannerRoot, 'experiments/agent-code-volume/2026-10-04-input-schema-fix-v2'));
const outputRoot = resolve(process.argv[3] ?? join(scannerRoot, 'experiments/agent-code-volume/2026-10-04-structured-limitations-input-v1'));
const wanted = new Map([
  ['DD-NPM-010', new Set(['L2'])],
  ['DD-NPM-013', new Set(['L1', 'L3'])],
  ['DD-NPM-003', new Set(['L4'])],
]);
const sourceManifest = await json(join(sourceRoot, 'manifest.json'));
const samples = [];
for (const sourceSample of sourceManifest.samples) {
  const levels = wanted.get(sourceSample.sourceSampleId);
  if (!levels) continue;
  const baseInput = await json(join(sourceRoot, 'private', sourceSample.experimentId, 'L0-input.json'));
  await output(join(outputRoot, 'private', sourceSample.experimentId, 'L0-input.json'), baseInput);
  const selectedLevels = [];
  for (const selected of sourceSample.levels.filter(({ level }) => levels.has(level))) {
    const sourceInputPath = join(sourceRoot, 'private', sourceSample.experimentId, `${selected.level}-input.json`);
    const input = await json(sourceInputPath);
    const prompt = buildAgentPromptV0_3(input, [], [], { additionalCodeRequests: 'DISABLED' });
    const request = {
      model: 'gpt-5.6-luna', input: prompt, store: false, reasoning: { effort: 'medium' }, max_output_tokens: 32768,
      text: { format: { type: 'json_schema', name: 'scanner_agent_analysis', schema: AGENT_OUTPUT_API_SCHEMA_V0_3, strict: false } },
    };
    await output(join(outputRoot, 'private', sourceSample.experimentId, `${selected.level}-input.json`), input);
    await output(join(outputRoot, 'private', sourceSample.experimentId, `${selected.level}-provider-request.json`), request);
    const serialized = JSON.stringify(request);
    selectedLevels.push({ ...selected, providerRequestBytes: Buffer.byteLength(serialized),
      providerRequestCharacters: serialized.length, estimatedTokens: Math.ceil(prompt.length / 4) });
  }
  samples.push({ ...sourceSample, levels: selectedLevels });
}
if (samples.flatMap(({ levels }) => levels).length !== 4) throw new Error('EXPECTED_EXACTLY_FOUR_CONDITIONS');
const manifest = {
  schemaVersion: '1.0.0', purpose: 'STRUCTURED_LIMITATIONS_V0_3_FOUR_CONDITION_INPUT', createdAt: new Date().toISOString(),
  sourceManifest: relative(scannerRoot, join(sourceRoot, 'manifest.json')),
  sourceManifestSha256: sha256(await readFile(join(sourceRoot, 'manifest.json'))),
  configuration: {
    model: 'gpt-5.6-luna', reasoningEffort: 'medium', maxOutputTokens: 32768, timeoutMs: 180000,
    retry: 0, store: false, jev: 'DISABLED', additionalCodeRequests: 'DISABLED', maxProviderRequests: 4,
    inputSchemaVersion: '0.3.0', outputSchemaVersion: '0.3.0', promptVersion: AGENT_PROMPT_VERSION_V0_3,
  },
  samples,
};
await output(join(outputRoot, 'manifest.json'), manifest);
await output(join(outputRoot, '.gitignore'), 'private/\n', false);
process.stdout.write(`${JSON.stringify({ output: relative(scannerRoot, outputRoot), conditionCount: 4 }, null, 2)}\n`);

async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function output(path, value, encode = true) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encode ? `${JSON.stringify(value, null, 2)}\n` : value);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
