/**
 * 난독화 후보 선별.
 *
 * 복원 도구는 비싸다. 여기가 예산을 결정하는 지점이다.
 *
 * 정렬 3단계
 *   1순위  실행 경로 확실성 — package.json 의 main/bin/exports/lifecycle 가 가리키는 파일
 *          dist/vendor.js 는 난독화 점수가 높아도 실행 안 될 수 있다
 *   2순위  난독화 점수 내림차순
 *   3순위  경로 사전순 — 같은 입력에 항상 같은 대상을 골라야 측정이 재현된다
 *
 * 탈락한 파일도 기록한다. 숨기면 "난독화 없는 깨끗한 패키지"로 오해된다.
 */
import { promises as fs } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

import type {
  Budget,
  CandidateContext,
  FileVerdict,
  SelectionResult,
  SkippedFile,
} from './obfuscation.types';
import type { AnalyzerResult } from '../../domain/analysis.types';
import { EvidenceMappingRegistry } from '../../evidence/normalizer/evidence-mapping.registry';
import { detect } from './detector';

const JS_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.bin', 'test', 'tests', '__tests__', 'spec']);
const EVIDENCE_MAPPINGS = new EvidenceMappingRegistry();

/**
 * Tier 1의 기존 Finding contract에서 위험 capability만 추출한다.
 * 새로운 taxonomy를 만들지 않고 GuardDog/custom-rule의 기존 type/ruleId를 사용한다.
 */
export function buildCandidateContext(tier1Results: AnalyzerResult[]): CandidateContext {
  const packageLevelRuleIds = new Set<string>();
  const ruleIdsByPath = new Map<string, Set<string>>();

  for (const result of tier1Results) {
    for (const finding of result.findings) {
      const mapping = EVIDENCE_MAPPINGS.find(result.analyzer, finding.ruleId);
      const isRiskCapability = mapping?.targets.some(({ signalId }) => (
        signalId.startsWith('capability.')
        && !signalId.startsWith('capability.lifecycle.')
      )) ?? false;
      if (!isRiskCapability) continue;

      const sourcePath = finding.location?.type === 'SOURCE_FILE'
        ? finding.location.path
        : undefined;
      if (sourcePath === undefined) {
        packageLevelRuleIds.add(finding.ruleId);
        continue;
      }

      const normalizedPath = normalizeCandidatePath(sourcePath);
      const pathRuleIds = ruleIdsByPath.get(normalizedPath) ?? new Set<string>();
      pathRuleIds.add(finding.ruleId);
      ruleIdsByPath.set(normalizedPath, pathRuleIds);
    }
  }

  return {
    riskCapabilityRuleIds: [...packageLevelRuleIds].sort(),
    riskCapabilityRuleIdsByPath: Object.fromEntries(
      [...ruleIdsByPath.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, ruleIds]) => [path, [...ruleIds].sort()]),
    ),
  };
}

function normalizeCandidatePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

export async function collectJsFiles(root: string, limit: number): Promise<{ files: string[]; limitHit: boolean }> {
  const files: string[] = [];
  let limitHit = false;

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= limit) { limitHit = true; return; }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) { limitHit = true; return; }
      // 심볼릭 링크는 따라가지 않는다. 압축 해제물의 경로는 신뢰 대상이 아니다.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (entry.isFile() && JS_EXTENSIONS.has(extname(entry.name))) files.push(full);
    }
  };

  await walk(root);
  return { files, limitHit };
}

/** package.json 이 가리키는 실행 진입점 경로들 (정규화된 상대 경로) */
export function entryPointPaths(packageJson: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      out.add(value.replace(/^\.\//, '').split(/[\\/]/).join(sep));
      return;
    }
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (value !== null && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(add);
    }
  };
  add(packageJson.main);
  add(packageJson.bin);
  add(packageJson.exports);

  // lifecycle 명령에서 언급되는 .js 파일도 진입점으로 본다 (예: "postinstall": "node install.js")
  const scripts = packageJson.scripts;
  if (scripts !== null && typeof scripts === 'object') {
    for (const command of Object.values(scripts as Record<string, unknown>)) {
      if (typeof command !== 'string') continue;
      for (const matched of command.matchAll(/[\w./-]+\.[cm]?js\b/g)) {
        out.add(matched[0].replace(/^\.\//, ''));
      }
    }
  }
  return out;
}

export async function selectTargets(
  extractedPath: string,
  packageJson: Record<string, unknown>,
  budget: Budget,
  candidateContext: CandidateContext = {},
): Promise<SelectionResult> {
  const { files, limitHit } = await collectJsFiles(extractedPath, budget.maxFilesScanned);
  const entries = entryPointPaths(packageJson);
  const isEntry = (path: string): boolean => entries.has(path) || entries.has(path.split(sep).join('/'));

  const verdicts: FileVerdict[] = [];
  const skipped: SkippedFile[] = [];

  for (const absolute of files) {
    const path = relative(extractedPath, absolute);
    let source: string;
    try {
      const stat = await fs.stat(absolute);
      if (stat.size > budget.maxFileBytes) { skipped.push({ path, reason: 'SIZE_LIMIT' }); continue; }
      // 내용이 거의 없는 파일만 제외한다. 작은 파일의 데이터 난독화 신호도 탐지 대상이다.
      if (stat.size < 32) { skipped.push({ path, reason: 'MIN_SIZE' }); continue; }
      source = await fs.readFile(absolute, 'utf8');
    } catch {
      skipped.push({ path, reason: 'READ_FAILED' });
      continue;
    }
    const normalizedPath = normalizeCandidatePath(path);
    const pathRiskRuleIds = candidateContext.riskCapabilityRuleIdsByPath?.[normalizedPath] ?? [];
    verdicts.push(detect(path, source, {
      ...candidateContext,
      riskCapabilityRuleIds: [
        ...(candidateContext.riskCapabilityRuleIds ?? []),
        ...pathRiskRuleIds,
      ],
      executionPath: isEntry(path),
    }));
  }

  if (limitHit) skipped.push({ path: '<scan>', reason: 'FILE_SCAN_LIMIT' });

  const ranked = verdicts
    .filter((verdict) => verdict.obfuscated)
    .sort((a, b) =>
      Number(isEntry(b.path)) - Number(isEntry(a.path))
      || b.score - a.score
      || a.path.localeCompare(b.path));

  const targets = ranked.slice(0, budget.maxTargets);
  for (const dropped of ranked.slice(budget.maxTargets)) {
    skipped.push({ path: dropped.path, reason: 'TARGET_LIMIT' });
  }

  return { verdicts, targets, skipped, scannedFiles: files.length, scanLimitHit: limitHit };
}
