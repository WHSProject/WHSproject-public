import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Agent Planning 맥락 점검을 실제 Jev(TypeSafe System One)로 1회 호출해 보는 수동 확인용 스크립트.
// 합성 Fixture만 전송하며 API 키는 출력하지 않는다. 실행 전 `npm run build`가 필요하다.
// 후보 선택 과정은 reports/validation/context-check-candidate-trace.ndjson(git 제외)에 줄 단위로 덧붙인다.
// `--fixture=chain`: 호출이 여러 파일에 걸친 Fixture로 LINK·ACTION 2단계 탐색을 본다(기본은 `install`).

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const scannerRoot = resolve(scriptDir, '..');
const repositoryRoot = resolve(scannerRoot, '../..');
const fixtureName = process.argv.find((arg) => arg.startsWith('--fixture='))?.slice('--fixture='.length) ?? 'install';

loadEnvironment(join(repositoryRoot, '.env'));
if (!process.env.TYPESAFE_API_KEY?.trim()) fail('TYPESAFE_API_KEY가 필요합니다.');

const { loadLlmAgentEnvironment } = require('../dist/config/scanner-environment.js');
const { AgentInputV0_3Builder, toPackageContextV0_3 } = require('../dist/llm-agent/artifact/agent-input-v0_3.builder.js');
const { RuntimeArtifactResolver } = require('../dist/llm-agent/artifact/runtime-artifact-resolver.js');
const { projectPackageContext } = require('../dist/llm-agent/llm-agent-input-builder.service.js');
const { runContextCheck } = require('../dist/llm-agent/context-check/context-check.service.js');
const { JevProviderClient } = require('../dist/llm-agent/context-check/jev-provider.client.js');
const { CANDIDATE_TRACE_RELATIVE_PATH, formatCandidateTrace } = require('../dist/llm-agent/context-check/candidate-trace.js');

const settings = loadLlmAgentEnvironment({
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  ...optional('TYPESAFE_BASE_URL'),
  ...optional('LLM_AGENT_CONTEXT_CHECK_MODEL'),
  LLM_AGENT_CONTEXT_CHECK_TIMEOUT_MS: process.env.LLM_AGENT_CONTEXT_CHECK_TIMEOUT_MS ?? '15000',
});

const ORIGINAL = `artifact:${'a'.repeat(64)}`;
const DEOBFUSCATED = `${ORIGINAL}:deobfuscated:${'b'.repeat(64)}`;
const FIXTURES = {
  // Tier 2 복원본의 install.js 18-19줄(전송)만 초기 슬라이스로 준다. postinstall이 install.js를 직접 실행한다.
  install: {
    root: join(scannerRoot, 'test', 'fixtures', 'tier3-context-check'), deobfuscated: true,
    filePath: 'install.js', range: { startLine: 18, endLine: 19 }, findingId: 'tier2:network:1', analyzer: 'custom-rule-deobfuscated',
  },
  // lib/transport.js 6-7줄(요청·전송)만 준다. 값은 lib/pack.js, 실행은 setup.js → lib/runner.js → push로 이어진다.
  chain: {
    root: join(scannerRoot, 'test', 'fixtures', 'tier3-context-check-chain'), deobfuscated: false,
    filePath: 'lib/transport.js', range: { startLine: 6, endLine: 7 }, findingId: 'tier1:network:1', analyzer: 'custom-rule',
  },
};
const fixture = FIXTURES[fixtureName] ?? fail(`알 수 없는 Fixture: ${fixtureName} (install, chain)`);
const FINDING = fixture.findingId;
const range = fixture.range;
const targetArtifact = fixture.deobfuscated ? DEOBFUSCATED : ORIGINAL;
const originalArtifact = {
  root: join(fixture.root, 'original'),
  descriptor: { artifactId: ORIGINAL, representation: 'ORIGINAL', analysisPass: 'TIER1', contentSha256: 'a'.repeat(64), lineageStatus: 'DIRECT', producer: 'scanner-safe-extractor' },
};
const deobfuscatedArtifact = {
  root: join(fixture.root, 'deobfuscated'),
  descriptor: {
    artifactId: DEOBFUSCATED, representation: 'DEOBFUSCATED', analysisPass: 'TIER2', contentSha256: 'b'.repeat(64),
    derivedFromArtifactId: ORIGINAL, lineageStatus: 'UNMAPPED', producer: 'scanner-obfuscation-restore',
  },
};
const policy = {
  codeSlices: {
    maxInitialSlices: settings.LLM_AGENT_MAX_INITIAL_SLICES,
    maxLinesPerSlice: settings.LLM_AGENT_MAX_LINES_PER_SLICE,
    maxInitialCodeLines: settings.LLM_AGENT_MAX_INITIAL_CODE_LINES,
    maxTotalCodeLines: settings.LLM_AGENT_MAX_TOTAL_CODE_LINES,
    maxFileSizeBytes: settings.LLM_AGENT_MAX_FILE_SIZE_BYTES,
  },
  maxToolCalls: settings.LLM_AGENT_MAX_TOOL_CALLS,
  maxAdditionalCodeRequests: settings.LLM_AGENT_MAX_ADDITIONAL_CODE_REQUESTS,
};
const execution = {
  validatedPlan: {
    planId: 'PLAN-CONTEXT-CHECK-SMOKE', shouldExecute: true, analysisMode: fixture.deobfuscated ? 'ORIGINAL_AND_DEOBFUSCATED' : 'ORIGINAL_ONLY',
    targets: [{
      targetId: 'tier3-target-001', artifactId: targetArtifact, filePath: fixture.filePath, preferredRange: range,
      priority: 'HIGH', findingRefs: [FINDING], evidenceRefs: [], reasonCodes: [fixture.deobfuscated ? 'TIER2_FINDING' : 'TIER1_FINDING'],
    }],
    focusBehaviors: ['NETWORK_EGRESS'], analysisTargets: [], limitations: [], validation: { status: 'VALIDATED' },
  },
  artifacts: new RuntimeArtifactResolver(fixture.deobfuscated ? [originalArtifact, deobfuscatedArtifact] : [originalArtifact]),
  findings: [{
    findingId: FINDING, analyzer: fixture.analyzer, analyzerVersion: '1', ruleId: 'custom.network-outbound', kind: 'CAPABILITY',
    description: 'Outbound network request', location: { file: fixture.filePath, ...range }, rawMatch: null,
  }],
  atomicEvidences: [],
  bindings: { findingBindings: [{ findingId: FINDING, artifactId: targetArtifact, filePath: fixture.filePath, ...range }], evidenceBindings: [] },
  packageContext: toPackageContextV0_3(projectPackageContext(JSON.parse(readFileSync(join(fixture.root, 'original', 'package.json'), 'utf8')))),
};

const builder = new AgentInputV0_3Builder();
const inputContext = { scanId: `context-check-smoke-${fixtureName}`, packageName: `tier3-context-check-${fixtureName}-fixture`, packageVersion: '1.0.0', archiveSha256: 'a'.repeat(64) };
const build = (input, supplement) => builder.build(input, inputContext, { ...policy, supplement });
const started = Date.now();
const traceEntries = [];
const outcome = await runContextCheck({
  enabled: true, provider: new JevProviderClient(settings), execution, built: await build(execution), rebuild: build, policy: policy.codeSlices,
  onCandidateTrace: (entries) => traceEntries.push(...entries),
});
const { record } = outcome;

console.log(`상태: ${record.status}${record.failureReason ? ` (${record.failureReason})` : ''}`);
console.log(`모델: ${record.model ?? '확인 불가'} / 소요: ${Date.now() - started}ms / 입력 토큰: ${record.usage?.inputTokens ?? '-'}`);
console.log(`\n맥락별 결과 (Fixture ${fixtureName}, 초기 슬라이스: ${fixture.filePath} ${range.startLine}-${range.endLine}줄)`);
for (const item of record.states) {
  console.log(`  ${item.context.padEnd(8)} ${item.state.padEnd(8)} score=${item.score.toFixed(2)} confidence=${item.confidence.toFixed(2)}`);
}
console.log('\n전달될 초기 슬라이스');
for (const slice of outcome.built.input.initialCodeSlices) {
  console.log(`  ${slice.sliceId} ${slice.filePath}:${slice.startLine}-${slice.endLine} (${slice.selectionReason})`);
}
const missing = outcome.built.input.missingData.filter((item) => item.field === 'contextCheck');
console.log(`\n미해결 맥락: ${missing.length === 0 ? '없음' : ''}`);
for (const item of missing) console.log(`  ${item.reason}`);
const tracePath = join(scannerRoot, CANDIDATE_TRACE_RELATIVE_PATH);
if (traceEntries.length > 0) {
  mkdirSync(dirname(tracePath), { recursive: true });
  appendFileSync(tracePath, formatCandidateTrace(traceEntries, { runId: `context-check-smoke-${fixtureName}-${randomUUID()}`, recordedAt: new Date().toISOString() }));
}
console.log(`\n후보 ${traceEntries.length}개 (선택 ${traceEntries.filter((entry) => entry.selected).length}개)${traceEntries.length > 0 ? `: ${tracePath}` : ''}`);
for (const entry of traceEntries) {
  console.log(`  ${entry.groupId} ${entry.context.padEnd(7)} 깊이${entry.depth} ${entry.kind.padEnd(20)} ${entry.filePath}:${entry.candidateStartLine}-${entry.candidateEndLine}${entry.symbol ? ` (${entry.symbol})` : ''} → ${entry.selected ? `선택 ${entry.selectedStartLine}-${entry.selectedEndLine}` : entry.exclusionReason}${entry.lowConfidenceMissing ? ` [LOW_CONFIDENCE_MISSING ${entry.score?.toFixed(2)}/${entry.confidence?.toFixed(2)}]` : ""}`);
}
if (record.status === 'UNAVAILABLE' || record.status === 'EXPANSION_FAILED') process.exitCode = 1;

function optional(name) {
  return process.env[name]?.trim() ? { [name]: process.env[name] } : {};
}

function loadEnvironment(path) {
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
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
