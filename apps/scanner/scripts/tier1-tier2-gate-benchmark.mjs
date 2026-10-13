import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { evaluateTier1Tier2Benchmark } from '../dist/performance/tier1-tier2-benchmark.js';

const args = parseArgs(process.argv.slice(2));
if (!args.input) throw new Error('MISSING_ARGUMENT:input');

const inputPath = resolve(args.input);
const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
const samples = Array.isArray(parsed) ? parsed : parsed.samples;
if (!Array.isArray(samples) || samples.length === 0) throw new Error('EMPTY_BENCHMARK_INPUT');
for (const sample of samples) {
  if (!sample || typeof sample.sampleId !== 'string') throw new Error('SAMPLE_ID_REQUIRED');
  if (sample.truth !== 'BENIGN' && sample.truth !== 'MALICIOUS') throw new Error(`INVALID_TRUTH:${sample.sampleId}`);
}

const report = evaluateTier1Tier2Benchmark(samples);
const output = `${JSON.stringify(report, null, 2)}\n`;
if (args.output) await writeFile(resolve(args.output), output, 'utf8');
process.stdout.write(output);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith('--')) continue;
    result[value.slice(2).replace(/-([a-z])/gu, (_, character) => character.toUpperCase())] = values[index + 1];
    index += 1;
  }
  return result;
}
