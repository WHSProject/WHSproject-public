import type { CodeSlice, FileShadowEvidence } from './agent-analysis.types';
import { canonicalizeEvidencePath } from './path-utils';

const FALLBACK_SINK =
  /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork|eval|Function|fetch|request|connect|createSocket|readFile|readFileSync|createReadStream|writeFile|writeFileSync)\s*\(|process\.env|os\.(?:homedir|hostname|userInfo|networkInterfaces)|\.npmrc|\.ssh|id_rsa|https?:\/\/[^\s'"`]+/u;

const DEFAULT_CONTEXT_LINES = 20;
const DEFAULT_MAX_CHARS = 24_000;

export function sliceCode(
  file: string,
  code: string,
  evidences: FileShadowEvidence[],
): CodeSlice[] {
  const canonicalFile = canonicalizeEvidencePath(file);
  const lines = redactSensitiveValues(code).split(/\r?\n/u);
  const anchors = new Set<number>();

  for (const evidence of evidences) {
    if (
      evidence.tier !== 'TIER_2' ||
      canonicalizeEvidencePath(evidence.path) !== canonicalFile ||
      evidence.line === null
    ) continue;
    if (evidence.line >= 1 && evidence.line <= lines.length) anchors.add(evidence.line - 1);
  }
  if (anchors.size === 0) {
    lines.forEach((line, index) => {
      if (FALLBACK_SINK.test(line)) anchors.add(index);
    });
  }
  if (anchors.size === 0) anchors.add(0);

  const windows: Array<[number, number]> = [];
  for (const anchor of [...anchors].sort((left, right) => left - right)) {
    const start = Math.max(0, anchor - DEFAULT_CONTEXT_LINES);
    const end = Math.min(lines.length - 1, anchor + DEFAULT_CONTEXT_LINES);
    const previous = windows.at(-1);
    if (previous !== undefined && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else windows.push([start, end]);
  }

  const slices: CodeSlice[] = [];
  let usedChars = 0;
  for (const [start, end] of windows) {
    const remaining = DEFAULT_MAX_CHARS - usedChars;
    if (remaining <= 0) break;
    const body = lines.slice(start, end + 1).join('\n').slice(0, remaining);
    if (body.length === 0) continue;
    usedChars += body.length;
    slices.push({
      file: canonicalFile,
      startLine: start + 1,
      endLine: start + body.split('\n').length,
      code: body,
    });
  }
  return slices;
}

/** 호출 구조는 보존하고 하드코딩된 민감값만 가린다. */
export function redactSensitiveValues(code: string): string {
  return code
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*)(['"`])[^'"`\r\n]+\2/giu,
      '$1$2<redacted>$2',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/giu, '$1<redacted>');
}
