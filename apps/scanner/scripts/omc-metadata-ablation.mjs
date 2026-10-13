import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { MetadataAnalyzer } from '../dist/analyzers/metadata/metadata.analyzer.js';
import { extractZipCodeOnly } from './tier2-omcbench-archive.mjs';

const reportPath = resolve(process.env.OMC_TIER2_REPORT ?? resolve(import.meta.dirname, '../../../reports/validation/tier2-omcbench-2026-09-23.json'));
const outputPath = resolve(process.env.OMC_ABLATION_OUTPUT ?? resolve(import.meta.dirname, '../../../reports/validation/tier1-tier2-omc-ablation-2026-09-28.json'));
const source = JSON.parse(await readFile(reportPath, 'utf8'));
const repository = source.source.repository.replace(/^https:\/\/github.com\//u, '');
const revision = source.source.revision;
const metadata = new MetadataAnalyzer();
const rows = [];

for (const item of source.cases) {
  const started = performance.now();
  const workRoot = await mkdtemp(join(tmpdir(), 'omc-metadata-'));
  try {
    const archiveUrl = `https://raw.githubusercontent.com/${repository}/${revision}/packages/${encodeURIComponent(item.name)}`;
    const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`DOWNLOAD_HTTP_${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const archivePath = join(workRoot, item.name);
    await writeFile(archivePath, archive);
    const packageJson = await readPackageJson(archivePath, item.name, workRoot);
    const result = metadata.analyzeResult(
      { registryMetadata: {}, packageJson },
      { requestId: `omc-metadata-${item.name}`, scanId: `omc-metadata-${item.name}` },
    );
    rows.push({
      sampleId: item.name,
      truth: item.label === 'malicious' ? 'MALICIOUS' : 'BENIGN',
      metadataFindingCount: result.findings.length,
      metadataPositive: result.findings.length > 0,
      tier2Positive: item.candidateFiles > 0,
      durationMs: Number((performance.now() - started).toFixed(2)),
      packageJsonKeys: Object.keys(packageJson).length,
    });
  } catch (error) {
    rows.push({
      sampleId: item.name,
      truth: item.label === 'malicious' ? 'MALICIOUS' : 'BENIGN',
      metadataFindingCount: null,
      metadataPositive: null,
      tier2Positive: item.candidateFiles > 0,
      durationMs: Number((performance.now() - started).toFixed(2)),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
  process.stdout.write(`${rows.length}/${source.cases.length} ${item.label} ${item.name}\n`);
}

const complete = rows.filter((row) => row.metadataPositive !== null);
const metrics = {
  metadataOnly: confusion(complete, (row) => row.metadataPositive === true),
  tier2Only: confusion(complete, (row) => row.tier2Positive === true),
  metadataAndTier2: confusion(complete, (row) => row.metadataPositive === true || row.tier2Positive === true),
  customRuleOnly: { status: 'NOT_RUN', reason: 'Semgrep executable is not installed in this environment.' },
  guardDogOnly: { status: 'NOT_RUN', reason: 'GuardDog/Docker daemon is unavailable; stored pilot raw is a different corpus.' },
  metadataAndCustomRule: { status: 'NOT_RUN', reason: 'Custom Rule unavailable.' },
  metadataAndGuardDog: { status: 'NOT_RUN', reason: 'GuardDog unavailable on the OMC corpus.' },
  customRuleAndGuardDog: { status: 'NOT_RUN', reason: 'Both external analyzers unavailable.' },
  allTier1: { status: 'NOT_RUN', reason: 'Custom Rule and GuardDog unavailable.' },
};
const output = {
  source: { repository, revision, inputReport: reportPath },
  corpus: { total: rows.length, completeMetadata: complete.length, benign: complete.filter((row) => row.truth === 'BENIGN').length, malicious: complete.filter((row) => row.truth === 'MALICIOUS').length },
  metadataLatencyMs: latency(complete.map((row) => row.durationMs)),
  metrics,
  rows,
  limitations: [
    'Tier2 candidate label is package maliciousness, not file-level obfuscation ground truth.',
    'Metadata used empty registry metadata; registry-side mismatch signals are therefore not measured.',
    'Custom Rule and GuardDog were not run on this corpus.',
  ],
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ outputPath, metrics }, null, 2)}\n`);

function confusion(items, predict) {
  const tp = items.filter((row) => row.truth === 'MALICIOUS' && predict(row)).length;
  const fp = items.filter((row) => row.truth === 'BENIGN' && predict(row)).length;
  const tn = items.filter((row) => row.truth === 'BENIGN' && !predict(row)).length;
  const fn = items.filter((row) => row.truth === 'MALICIOUS' && !predict(row)).length;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return { tp, fp, tn, fn, precision, recall, f1: precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall), fpr: ratio(fp, fp + tn), fnr: ratio(fn, fn + tp) };
}

function ratio(a, b) { return b === 0 ? null : a / b; }
function latency(values) {
  if (values.length === 0) return { p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

async function readPackageJson(archivePath, name, workRoot) {
  if (archivePath.endsWith('.zip')) {
    const extractedPath = join(workRoot, 'extracted');
    await mkdir(extractedPath);
    const result = await extractZipCodeOnly(archivePath, extractedPath);
    const candidate = result.files.find((file) => file === 'package/package.json') ?? result.files.find((file) => file.endsWith('/package.json'));
    return candidate === undefined ? {} : JSON.parse(await readFile(join(extractedPath, candidate), 'utf8'));
  }
  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 10_000 })
    .split(/\r?\n/u)
    .filter((entry) => entry.endsWith('package.json'));
  for (const entry of entries) {
    try {
      return JSON.parse(execFileSync('tar', ['-xOzf', archivePath, entry], { encoding: 'utf8', timeout: 10_000 }));
    } catch { /* try the next package manifest */ }
  }
  return {};
}
