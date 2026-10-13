import { readFile } from 'node:fs/promises';

import type { AnalysisContext } from '../../domain/analysis.types';
import type {
  AgentAnalysisCandidate,
  AgentAnalysisRequestV0_1,
} from './agent-analysis.types';
import { sliceCode } from './code-slicer';
import type { SelectedGptCandidate } from './evidence-bundle';
import type { RestoreResult } from './obfuscation.types';
import { canonicalizeEvidencePath } from './path-utils';

const MAX_CANDIDATE_SLICE_CHARS = 30_000;

export async function buildAgentAnalysisRequest(
  context: AnalysisContext,
  candidates: SelectedGptCandidate[],
  restore: RestoreResult,
): Promise<AgentAnalysisRequestV0_1 | undefined> {
  const restoredByPath = new Map(restore.restored
    .map((file) => [canonicalizeEvidencePath(file.path), file]));
  const requestCandidates: AgentAnalysisCandidate[] = [];

  for (const candidate of candidates) {
    try {
      const code = await readFile(candidate.sourcePath, 'utf8');
      const normalizedPath = canonicalizeEvidencePath(candidate.path);
      const slices = sliceCode(normalizedPath, code, candidate.bundle.evidences);
      const restored = restoredByPath.get(normalizedPath);

      if (restored !== undefined) {
        for (const [index, payload] of restored.payloads.entries()) {
          try {
            const payloadCode = await readFile(payload.outputPath, 'utf8');
            slices.push(...sliceCode(
              `${normalizedPath}.payload-${index + 1}.js`,
              payloadCode,
              [],
            ));
          } catch {
            // 주 복원본은 유지하고 읽을 수 없는 파생 payload만 제외한다.
          }
        }
      }

      requestCandidates.push({
        path: normalizedPath,
        sourceKind: candidate.sourceKind,
        reason: candidate.reason,
        supportingReasons: candidate.supportingReasons,
        restored: candidate.restored,
        matchedSignals: candidate.matchedSignals,
        residualCapabilities: candidate.residualCapabilities,
        derivedNewRuleIds: candidate.derivedNewRuleIds,
        restoration: {
          status: candidate.bundle.restoration.status,
          ...(candidate.bundle.restoration.reason === undefined ? {} : {
            reason: candidate.bundle.restoration.reason,
          }),
          limitations: candidate.bundle.restoration.limitations,
          stageResults: candidate.bundle.restoration.stageResults,
          appliedStages: candidate.bundle.restoration.appliedStages,
          ...(candidate.bundle.restoration.validation === undefined ? {} : {
            validation: candidate.bundle.restoration.validation,
          }),
        },
        evidences: candidate.bundle.evidences,
        slices: limitSlices(slices),
      });
    } catch {
      // 파일 하나를 읽지 못해도 다른 후보의 Shadow 분석은 계속한다.
    }
  }

  if (requestCandidates.length === 0) return undefined;
  const packageJson = context.metadata.packageJson;
  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  const lifecycleScripts = (['preinstall', 'install', 'postinstall'] as const)
    .flatMap((name) => typeof scripts[name] === 'string'
      ? [{ name, command: scripts[name] as string }]
      : []);
  return {
    schemaVersion: '0.1',
    requestId: context.requestId,
    scanId: context.scanId,
    sampleId: context.artifact.hash,
    purpose: 'DEOBFUSCATION_CODE_UNDERSTANDING',
    package: {
      ecosystem: 'npm',
      name: context.package.name,
      version: context.package.version,
      artifactHash: context.artifact.hash,
      description: typeof packageJson.description === 'string' ? packageJson.description : null,
      lifecycleScripts,
    },
    candidates: requestCandidates,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function limitSlices(
  slices: AgentAnalysisCandidate['slices'],
): AgentAnalysisCandidate['slices'] {
  const output: AgentAnalysisCandidate['slices'] = [];
  let remaining = MAX_CANDIDATE_SLICE_CHARS;
  for (const slice of slices) {
    if (remaining <= 0) break;
    const code = slice.code.slice(0, remaining);
    if (code.length === 0) continue;
    output.push({
      ...slice,
      code,
      endLine: slice.startLine + code.split('\n').length - 1,
    });
    remaining -= code.length;
  }
  return output;
}
