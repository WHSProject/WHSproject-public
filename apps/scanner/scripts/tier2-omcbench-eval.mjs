import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BUDGET } from '../dist/analyzers/obfuscation/obfuscation.types.js';
import { runRestorePipeline } from '../dist/analyzers/obfuscation/restore.pipeline.js';
import { selectTargets } from '../dist/analyzers/obfuscation/target-selector.js';
import { extractZipCodeOnly } from './tier2-omcbench-archive.mjs';
import {
  RESTORE_STATUS_KEYS,
  aggregateGroup,
  buildCandidateReports,
  percentileOrNull,
  summarizeRestoration,
  summarizeSelection,
  validateBenchmarkDataset,
} from '../dist/performance/tier2-omcbench-aggregation.js';

const revision = 'f0722971eddb654c308106c9086ff69da5b0484b';
const repository = 'False-Positive-Community/open-malicious-code-benchmark';
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const defaultReport = resolve(scriptRoot, '../../../reports/validation/tier2-omcbench-2026-09-23.md');
const reportPath = process.env.TIER2_REPORT_PATH ?? defaultReport;
const jsonReportPath = process.env.TIER2_JSON_PATH ?? reportPath.replace(/\.md$/u, '.json');
const samplesPerLabel = Number(process.env.TIER2_SAMPLES_PER_LABEL ?? '20');
if (!Number.isInteger(samplesPerLabel) || samplesPerLabel < 1 || samplesPerLabel > 200) {
  throw new Error('TIER2_SAMPLES_PER_LABEL은 1~200 사이 정수여야 합니다.');
}

const manifestText = await downloadText(
  `https://raw.githubusercontent.com/${repository}/${revision}/results/manifest.csv`,
);
const packageMetadata = await downloadJson(
  `https://api.github.com/repos/${repository}/contents/packages?ref=${revision}&per_page=1000`,
);
const sizes = new Map(packageMetadata.map((item) => [item.name, item.size]));
const manifest = manifestText.trim().split(/\r?\n/u).slice(1)
  .map((line) => line.split(','))
  .filter(([, ecosystem]) => ecosystem === 'js');
const chosen = ['benign', 'malicious'].flatMap((label) => {
  const eligible = manifest
    .filter(([name, , rowLabel]) => rowLabel === label && sizes.get(name) <= 1_000_000)
    .map(([name]) => ({ name, label, archiveBytes: sizes.get(name) }));
  return Array.from({ length: Math.min(samplesPerLabel, eligible.length) }, (_, index) => (
    eligible[Math.floor((index + 0.5) * eligible.length / Math.min(samplesPerLabel, eligible.length))]
  ));
});

const results = [];
for (const sample of chosen) {
  const started = performance.now();
  const workRoot = await mkdtemp(join(tmpdir(), 'tier2-omcbench-'));
  const archivePath = join(workRoot, sample.name);
  const extractedPath = join(workRoot, 'extracted');
  try {
    const bytes = await downloadBytes(
      `https://raw.githubusercontent.com/${repository}/${revision}/packages/${encodeURIComponent(sample.name)}`,
    );
    if (bytes.length > 1_000_000) throw new Error('아카이브 크기 제한 초과');
    await writeFile(archivePath, bytes);
    await mkdir(extractedPath);
    const { files: extractedFiles, skippedLargeFiles } = await extractCodeOnly(archivePath, extractedPath);
    const packageJson = await findPackageJson(extractedPath, extractedFiles);
    const analysisStarted = performance.now();
    const selection = await selectTargets(extractedPath, packageJson, DEFAULT_BUDGET);
    const restoration = await runRestorePipeline({
      extractedPath,
      outputRoot: join(workRoot, 'derived', 'obfuscation'),
      targets: selection.targets,
      budget: DEFAULT_BUDGET,
    });
    results.push({
      ...sample,
      completed: true,
      status: '완료',
      archiveFiles: extractedFiles.length,
      skippedLargeFiles,
      scannedFiles: selection.scannedFiles,
      scanLimitHit: selection.scanLimitHit,
      candidateFiles: selection.targets.length,
      selection,
      restoration,
      candidateReports: buildCandidateReports(selection, restoration),
      restoredFiles: restoration.restored.filter((file) => file.status === 'RESTORED').length,
      partialFiles: restoration.restored.filter((file) => file.status === 'PARTIAL_RESTORED').length,
      unresolvedFiles: restoration.unresolved.length,
      signals: [...new Set(selection.targets.flatMap((file) => file.signals))].sort(),
      analysisMs: Number((performance.now() - analysisStarted).toFixed(2)),
      durationMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    results.push({
      ...sample,
      completed: false,
      status: '실패',
      error: String(error.message).slice(0, 180),
      durationMs: Math.round(performance.now() - started),
    });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
  console.log(`${results.length}/${chosen.length} ${sample.label} ${sample.name}: ${results.at(-1).status}`);
}

const completedCases = results.filter((item) => item.completed === true);
const validationErrors = validateBenchmarkDataset(chosen, completedCases);
const benchmarkValid = validationErrors.length === 0;
const groupSummaries = ['benign', 'malicious'].map((label) => (
  aggregateGroup(label, completedCases, benchmarkValid)
));
const analysisDurationsForReport = completedCases.flatMap((item) => (
  item.analysisMs === undefined ? [] : [item.analysisMs]
));
const durationsForReport = completedCases.map((item) => item.durationMs);
const overallRestore = {
  statusCounts: Object.fromEntries(RESTORE_STATUS_KEYS.map((status) => [status, 0])),
  reasonCounts: {},
};
const overallSelectionSkipped = {};
for (const group of groupSummaries) {
  for (const status of RESTORE_STATUS_KEYS) {
    overallRestore.statusCounts[status] += group.restore.statusCounts[status];
  }
  for (const [reason, count] of Object.entries(group.restore.reasonCounts)) {
    overallRestore.reasonCounts[reason] = (overallRestore.reasonCounts[reason] ?? 0) + count;
  }
  for (const [reason, count] of Object.entries(group.selectionSkipped)) {
    overallSelectionSkipped[reason] = (overallSelectionSkipped[reason] ?? 0) + count;
  }
}
const caseDetails = results.map((item) => ({
  label: item.label,
  name: item.name,
  status: item.status,
  error: item.error,
  scannedFiles: item.scannedFiles ?? 0,
  candidateFiles: item.candidateFiles ?? 0,
  scanLimitHit: item.scanLimitHit ?? false,
  skippedLargeFiles: item.skippedLargeFiles ?? 0,
  selectionSkipped: item.selection === undefined ? {} : summarizeSelection(item.selection),
  restore: item.restoration === undefined ? null : summarizeRestoration(item.restoration),
  candidates: item.candidateReports ?? [],
}));

const completed = results.filter((item) => item.status === '완료');
const summary = ['benign', 'malicious'].map((label) => {
  const group = completed.filter((item) => item.label === label);
  return {
    label,
    packages: group.length,
    withCandidate: group.filter((item) => item.candidateFiles > 0).length,
    candidateFiles: group.reduce((sum, item) => sum + item.candidateFiles, 0),
    restoredFiles: group.reduce((sum, item) => sum + item.restoredFiles, 0),
    partialFiles: group.reduce((sum, item) => sum + item.partialFiles, 0),
    unresolvedFiles: group.reduce((sum, item) => sum + item.unresolvedFiles, 0),
    scannedFiles: group.reduce((sum, item) => sum + item.scannedFiles, 0),
    skippedLargeFiles: group.reduce((sum, item) => sum + item.skippedLargeFiles, 0),
    scanLimitPackages: group.filter((item) => item.scanLimitHit).length,
  };
});
const durations = completed.map((item) => item.durationMs).sort((a, b) => a - b);
const analysisDurations = completed.map((item) => item.analysisMs).sort((a, b) => a - b);
const percentile = (values, fraction) => values.length === 0
  ? 'NOT_MEASURED'
  : values[Math.ceil(values.length * fraction) - 1];
const report = [
  '# Tier 2 외부 실제 데이터셋 평가',
  '',
  `- 평가 시각: ${new Date().toISOString()}`,
  `- 출처: https://github.com/${repository}`,
  `- 고정 커밋: \`${revision}\``,
  `- 표본: npm 정상·악성 각 ${samplesPerLabel}개, 원본 manifest 순서에서 등간격 선택, 1MB 이하 아카이브만 포함`,
  '- 실행 범위: JS 후보 탐지 → webcrack/Babel 복원. 샘플의 설치 스크립트·패키지 진입점 실행 없음.',
  '- 주의: 정답 라벨은 패키지 악성 여부이지 난독화 여부가 아닙니다. 아래 후보율은 악성 탐지 Recall/정확도가 아닙니다.',
  '',
  '| 라벨 | 완료 패키지 | 후보가 있는 패키지 | 후보 파일 | 완전 복원 | 부분 복원 | 미복원 | 검사 JS 파일 | 큰 파일 제외 | 검사 제한 패키지 |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...summary.map((item) => `| ${item.label} | ${item.packages} | ${item.withCandidate} | ${item.candidateFiles} | ${item.restoredFiles} | ${item.partialFiles} | ${item.unresolvedFiles} | ${item.scannedFiles} | ${item.skippedLargeFiles} | ${item.scanLimitPackages} |`),
  '',
  `- Tier 2 단독 처리 시간(후보 탐지·복원): p50 ${percentile(analysisDurations, 0.5)}ms / p95 ${percentile(analysisDurations, 0.95)}ms`,
  `- 전체 표본 처리 시간(다운로드·압축 읽기 포함): p50 ${percentile(durations, 0.5)}ms / p95 ${percentile(durations, 0.95)}ms`,
  `- 실패/제외: ${results.length - completed.length}건`,
  '',
  '## 패키지별 결과',
  '',
  '| 라벨 | 패키지 | 상태 | 검사 JS | 큰 파일 제외 | 후보 | 완전/부분/미복원 | 신호 또는 오류 | 시간(ms) |',
  '|---|---|---|---:|---:|---:|---|---|---:|',
  ...results.map((item) => `| ${item.label} | \`${item.name}\` | ${item.status} | ${item.scannedFiles ?? '-'} | ${item.skippedLargeFiles ?? '-'} | ${item.candidateFiles ?? '-'} | ${item.restoredFiles ?? '-'} / ${item.partialFiles ?? '-'} / ${item.unresolvedFiles ?? '-'} | ${(item.signals?.join(', ') ?? item.error ?? '-').replaceAll('|', '/')} | ${item.durationMs} |`),
  '',
  '## 해석 제한',
  '',
  '- 체계적 등간격 표본이며 아카이브 1MB 제한 때문에 전체 400개 npm 모집단의 성능 추정으로 일반화할 수 없습니다.',
  '- 악성 패키지라도 난독화가 없으면 Tier 2 후보가 없는 것이 정상일 수 있습니다.',
  '- Tier 1 Finding 없이 난독화 모듈 단독으로 측정했으므로 실제 통합 후보율은 달라질 수 있습니다.',
  '- 압축 파일에서 JS와 package.json만 읽었으므로 전체 Scanner·GuardDog·Gemini 성능 수치가 아닙니다.',
  '- 실패한 표본은 분모에서 따로 표시하며 성공으로 간주하지 않습니다.',
  '',
].join('\n');

const formatRate = (value) => value === null ? 'NOT_MEASURED' : `${(value * 100).toFixed(2)}%`;
const enhancedReport = [
  report,
  '',
  '## #280 Benchmark Aggregation',
  '',
  `- benchmarkStatus: ${benchmarkValid ? 'VALID' : 'INVALID'}`,
  `- validationErrors: ${validationErrors.length === 0 ? 'none' : validationErrors.join(', ')}`,
  '- positiveCandidateRecall: UNAVAILABLE (file-level Obfuscation ground truth 없음)',
  '- routingConfusionMatrix: UNAVAILABLE (TP/FP/TN/FN ground truth 없음)',
  '- minifyBundleFalsePositive: NOT_MEASURED (dataset ground truth 없음)',
  '- detectorRestoreSplit: NOT_MEASURED (analysisMs는 selector/detector와 restore를 합산)',
  '',
  '| label | completed packages | candidate packages | candidate package rate | candidate files | scanned JS files |',
  '|---|---:|---:|---:|---:|---:|',
  ...groupSummaries.map((group) => `| ${group.label} | ${group.packages} | ${group.withCandidate} | ${formatRate(group.benignOrMaliciousCandidatePackageRate)} | ${group.candidateFiles} | ${group.scannedFiles} |`),
  '',
  '## Restore Status Aggregation',
  '',
  ...RESTORE_STATUS_KEYS.map((status) => `- ${status}: ${overallRestore.statusCounts[status]}`),
  `- selector skipped: ${JSON.stringify(overallSelectionSkipped)}`,
  `- restore reason breakdown: ${JSON.stringify(overallRestore.reasonCounts)}`,
  '',
  '## Timing',
  '',
  `- analysis p50/p95: ${percentileOrNull(analysisDurationsForReport, 0.5) ?? 'NOT_MEASURED'}ms / ${percentileOrNull(analysisDurationsForReport, 0.95) ?? 'NOT_MEASURED'}ms`,
  `- package total p50/p95: ${percentileOrNull(durationsForReport, 0.5) ?? 'NOT_MEASURED'}ms / ${percentileOrNull(durationsForReport, 0.95) ?? 'NOT_MEASURED'}ms`,
  '- Agent/LLM latency: NOT_MEASURED (이 runner는 GPT/Agent를 실행하지 않음)',
  '',
  '## Case-level Details',
  '',
  '```json',
  JSON.stringify(caseDetails, null, 2),
  '```',
  '',
].join('\n');

const jsonReport = {
  benchmarkStatus: benchmarkValid ? 'VALID' : 'INVALID',
  validationErrors,
  source: { repository, revision },
  metrics: {
    positiveCandidateRecall: 'UNAVAILABLE',
    routingConfusionMatrix: 'UNAVAILABLE',
    minifyBundleFalsePositive: 'NOT_MEASURED',
    benignCandidatePackageRate: groupSummaries[0].benignOrMaliciousCandidatePackageRate,
    maliciousCandidatePackageRate: groupSummaries[1].benignOrMaliciousCandidatePackageRate,
    analysisP50Ms: percentileOrNull(analysisDurationsForReport, 0.5),
    analysisP95Ms: percentileOrNull(analysisDurationsForReport, 0.95),
    packageTotalP50Ms: percentileOrNull(durationsForReport, 0.5),
    packageTotalP95Ms: percentileOrNull(durationsForReport, 0.95),
  },
  restore: overallRestore,
  selectionSkipped: overallSelectionSkipped,
  groups: groupSummaries,
  cases: caseDetails,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, enhancedReport, 'utf8');
await writeFile(jsonReportPath, JSON.stringify(jsonReport, null, 2), 'utf8');
console.log(`보고서: ${reportPath}`);
console.log(`JSON report: ${jsonReportPath}`);
if (completed.length !== results.length || !benchmarkValid) process.exitCode = 1;

async function downloadBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`다운로드 HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadText(url) {
  return (await downloadBytes(url)).toString('utf8');
}

async function downloadJson(url) {
  return JSON.parse(await downloadText(url));
}

async function extractCodeOnly(archivePath, extractedPath) {
  if (archivePath.endsWith('.zip')) return extractZipCodeOnly(archivePath, extractedPath);

  const entries = execFileSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 5_000_000,
  }).split(/\r?\n/u);
  if (entries.length > 2_000) throw new Error('아카이브 항목 수 제한 초과');
  const extracted = [];
  let skippedLargeFiles = 0;
  let extractedBytes = 0;
  for (const entry of entries) {
    if (!/\.(?:js|cjs|mjs|json)$/iu.test(entry)) continue;
    if (extracted.length >= 1_000) throw new Error('코드 파일 수 제한 초과');
    if (entry.startsWith('/') || entry.includes('\\') || entry.includes('\0')) continue;
    const normalized = posix.normalize(entry.replace(/^\.\//u, ''));
    if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) continue;
    let content;
    try {
      content = execFileSync('tar', ['-xOzf', archivePath, entry], {
        timeout: 10_000,
        maxBuffer: 600_000,
      });
    } catch (error) {
      if (error.code === 'ENOBUFS') {
        skippedLargeFiles += 1;
        continue;
      }
      throw error;
    }
    if (content.length > 512_000) {
      skippedLargeFiles += 1;
      continue;
    }
    extractedBytes += content.length;
    if (extractedBytes > 20_000_000) throw new Error('코드 총 해제 용량 제한 초과');
    const destination = join(extractedPath, normalized);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    extracted.push(normalized);
  }
  return { files: extracted, skippedLargeFiles };
}

async function findPackageJson(extractedPath, extractedFiles) {
  const packagePath = extractedFiles.find((path) => path === 'package/package.json')
    ?? extractedFiles.find((path) => path === 'package.json')
    ?? extractedFiles.find((path) => path.endsWith('/package.json'));
  if (packagePath === undefined) return {};
  try {
    return JSON.parse(await readFile(join(extractedPath, packagePath), 'utf8'));
  } catch {
    return {};
  }
}
