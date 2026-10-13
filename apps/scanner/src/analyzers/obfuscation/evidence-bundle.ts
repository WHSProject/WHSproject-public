import { join } from 'node:path';

import type { AnalyzerResult, Finding } from '../../domain/analysis.types';
import type {
  FileEvidenceBundle,
  FileShadowEvidence,
  GptCandidateReason,
  RestoreProvenance,
} from './agent-analysis.types';
import type {
  RestoreResult,
  UnresolvedFile,
  RestoredFile,
} from './obfuscation.types';
import { canonicalizeEvidencePath } from './path-utils';

type HandoffUnresolvedFile = Omit<UnresolvedFile, 'status'> & {
  status: 'UNRESOLVED' | 'FAILED';
};

const CAPABILITY_RULES: Record<string, RegExp> = {
  PROCESS: /custom\.(?:signal\.process-access|process-execution)|capability-process|threat-.*process/u,
  NETWORK: /custom\.(?:signal\.network-access|network-outbound)|capability-network-outbound|threat-network/u,
  DOWNLOAD: /custom\.remote-download|capability-network-download|threat-.*download/u,
  CREDENTIAL: /custom\.(?:signal\.sensitive-file-access|credential-source)|threat-.*credential|suspicious_passwd/u,
  COLLECTION: /custom\.collection-source|threat-runtime-system-info|threat-.*sysinfo|npm-exfiltrate-sensitive-data/u,
  ENV: /custom\.signal\.environment-access|threat-runtime-environment|npm-serialize-environment/u,
  DYNAMIC_EXEC: /obfuscation\.technique\.dynamic-eval|npm-exec-base64|threat-.*obfuscation/u,
  OBFUSCATION: /obfuscation\.detected|npm-obfuscation/u,
  LIFECYCLE: /metadata\.lifecycle\.(?:preinstall|install|postinstall)|custom\.lifecycle-entry|npm-install-script/u,
};

const STRONG_COMBINATIONS: Array<{ id: string; needs: string[] }> = [
  { id: 'COLLECTION_TO_NETWORK', needs: ['COLLECTION', 'NETWORK'] },
  { id: 'CREDENTIAL_TO_NETWORK', needs: ['CREDENTIAL', 'NETWORK'] },
  { id: 'ENV_TO_NETWORK', needs: ['ENV', 'NETWORK'] },
  { id: 'DOWNLOAD_TO_PROCESS', needs: ['DOWNLOAD', 'PROCESS'] },
  { id: 'LIFECYCLE_TO_PROCESS', needs: ['LIFECYCLE', 'PROCESS'] },
  { id: 'LIFECYCLE_TO_NETWORK', needs: ['LIFECYCLE', 'NETWORK'] },
  { id: 'OBFUSCATION_AND_PROCESS', needs: ['OBFUSCATION', 'PROCESS'] },
  { id: 'OBFUSCATION_AND_NETWORK', needs: ['OBFUSCATION', 'NETWORK'] },
  { id: 'DYNAMIC_EXEC_AND_NETWORK', needs: ['DYNAMIC_EXEC', 'NETWORK'] },
];

export interface SelectedGptCandidate {
  path: string;
  sourcePath: string;
  sourceKind: 'ORIGINAL' | 'RESTORED';
  restored: boolean;
  reason: GptCandidateReason;
  supportingReasons: GptCandidateReason[];
  matchedSignals: string[];
  residualCapabilities: string[];
  derivedNewRuleIds: string[];
  bundle: FileEvidenceBundle;
}

export function buildFileEvidenceBundles(
  tier1Results: AnalyzerResult[],
  obfuscationResult: AnalyzerResult,
  derivedResults: AnalyzerResult[],
  restore: RestoreResult,
): FileEvidenceBundle[] {
  const restoredByPath = new Map(restore.restored.map((file) => [canonicalizeEvidencePath(file.path), file]));
  const unresolvedByPath = new Map(restore.unresolved
    .filter((file): file is HandoffUnresolvedFile => (
      file.status !== 'SKIPPED'
    ))
    .map((file) => [canonicalizeEvidencePath(file.path), file]));
  const paths = [...new Set([...restoredByPath.keys(), ...unresolvedByPath.keys()])].sort();

  return paths.map((path) => {
    const restored = restoredByPath.get(path);
    const unresolved = unresolvedByPath.get(path);
    const restoration = toRestoreProvenance(restored ?? unresolved);
    const tier1 = findingsForPath(tier1Results, path, true)
      .map(({ result, finding }) => toEvidence('TIER_1', result, finding, path));
    const tier2 = [
      ...findingsForPath([obfuscationResult], path, false),
      ...findingsForPath(derivedResults, path, false),
    ].map(({ result, finding }) => toEvidence('TIER_2', result, finding, path));
    const evidences = deduplicate([...tier1, ...tier2]);
    const originalRuleIds = new Set(tier1
      .filter((evidence) => evidence.path === path)
      .map((evidence) => evidence.ruleId));
    const newRuleIds = [...new Set(tier2
      .filter((evidence) => evidence.analyzer.endsWith('-deobfuscated'))
      .map((evidence) => evidence.ruleId)
      .filter((ruleId) => !originalRuleIds.has(ruleId)))].sort();
    const capabilities = Object.entries(CAPABILITY_RULES)
      .filter(([, pattern]) => evidences.some(({ ruleId }) => pattern.test(ruleId)))
      .map(([name]) => name);
    const strongCombinations = STRONG_COMBINATIONS
      .filter(({ needs }) => needs.every((need) => capabilities.includes(need)))
      .map(({ id }) => id);

    return {
      path,
      restoreStatus: restoration.status,
      appliedStages: restoration.appliedStages,
      restoration,
      evidences,
      newRuleIds,
      capabilities,
      strongCombinations,
    };
  });
}

export function selectGptCandidates(
  bundles: FileEvidenceBundle[],
  restore: RestoreResult,
  extractedPath: string,
): SelectedGptCandidate[] {
  const restoredByPath = new Map(restore.restored
    .map((file) => [canonicalizeEvidencePath(file.path), file]));
  const riskCapabilities = new Set([
    'PROCESS', 'NETWORK', 'DOWNLOAD', 'CREDENTIAL', 'COLLECTION', 'ENV',
  ]);

  return bundles.flatMap((bundle): SelectedGptCandidate[] => {
    const restored = restoredByPath.get(bundle.path);
    const hasRisk = bundle.capabilities.some((capability) => riskCapabilities.has(capability));
    const dynamicExecutionRemains = bundle.evidences.some((evidence) =>
      evidence.tier === 'TIER_2' &&
      evidence.analyzer.endsWith('-deobfuscated') &&
      CAPABILITY_RULES.DYNAMIC_EXEC?.test(evidence.ruleId) === true);
    const supportingReasons: GptCandidateReason[] = [];
    let matchedSignals: string[] = [];

    if (bundle.strongCombinations.length > 0) {
      supportingReasons.push('STRONG_RISK_COMBINATION');
      matchedSignals = bundle.strongCombinations;
    }
    if (dynamicExecutionRemains) {
      supportingReasons.push('DYNAMIC_EXEC_REMAINS');
      if (matchedSignals.length === 0) {
        matchedSignals = bundle.evidences
          .filter((evidence) =>
            evidence.tier === 'TIER_2' &&
            evidence.analyzer.endsWith('-deobfuscated') &&
            CAPABILITY_RULES.DYNAMIC_EXEC?.test(evidence.ruleId) === true)
          .map((evidence) => evidence.ruleId);
      }
    }
    if (restored !== undefined && bundle.newRuleIds.length > 0) {
      supportingReasons.push('RESTORED_WITH_NEW_SIGNAL');
      if (matchedSignals.length === 0) {
        matchedSignals = bundle.newRuleIds;
      }
    }
    if (bundle.restoration.status === 'PARTIAL_RESTORED' && hasRisk) {
      supportingReasons.push('PARTIAL_RESTORED_WITH_RISK');
      if (matchedSignals.length === 0) {
        matchedSignals = bundle.capabilities;
      }
    }
    if (bundle.restoration.status === 'UNRESOLVED' && hasRisk) {
      supportingReasons.push('UNRESOLVED_OBFUSCATION_WITH_RISK');
      if (matchedSignals.length === 0) {
        matchedSignals = bundle.capabilities;
      }
    }
    if (bundle.restoration.status === 'FAILED' && hasRisk) {
      supportingReasons.push('FAILED_WITH_RISK');
      if (matchedSignals.length === 0) {
        matchedSignals = bundle.capabilities;
      }
    }

    const reason = supportingReasons[0];
    if (reason === undefined) return [];
    return [{
      path: bundle.path,
      sourcePath: restored?.outputPath ?? join(extractedPath, bundle.path),
      sourceKind: restored === undefined ? 'ORIGINAL' : 'RESTORED',
      restored: restored !== undefined,
      reason,
      supportingReasons,
      matchedSignals,
      residualCapabilities: bundle.capabilities,
      derivedNewRuleIds: bundle.newRuleIds,
      bundle,
    }];
  });
}

function findingsForPath(
  results: AnalyzerResult[],
  path: string,
  includePackageEvidence: boolean,
): Array<{ result: AnalyzerResult; finding: Finding }> {
  return results.flatMap((result) => result.findings
    .filter((finding) => {
      const findingPath = finding.location?.path === undefined
        ? undefined
        : canonicalizeEvidencePath(finding.location.path);
      const canonicalPath = canonicalizeEvidencePath(path);
      if (findingPath === canonicalPath || findingPath?.startsWith(`${canonicalPath}.payload-`) === true) return true;
      return includePackageEvidence && finding.ruleId.startsWith('metadata.lifecycle.');
    })
    .map((finding) => ({ result, finding })));
}

function toEvidence(
  tier: FileShadowEvidence['tier'],
  result: AnalyzerResult,
  finding: Finding,
  fallbackPath: string,
): FileShadowEvidence {
  return {
    evidenceId: `${tier}:${finding.findingId}`,
    tier,
    analyzer: result.analyzer,
    ruleId: finding.ruleId,
    message: finding.message,
    path: canonicalizeEvidencePath(
      finding.location?.path ?? (finding.location?.type === 'METADATA' ? 'package.json' : fallbackPath),
    ),
    line: finding.location?.startLine ?? null,
  };
}

function deduplicate(evidences: FileShadowEvidence[]): FileShadowEvidence[] {
  return [...new Map(evidences.map((evidence) => [evidence.evidenceId, evidence])).values()];
}

function toRestoreProvenance(
  file: RestoredFile | HandoffUnresolvedFile | undefined,
): RestoreProvenance {
  if (file === undefined) {
    return {
      status: 'UNRESOLVED',
      limitations: [],
      stageResults: [],
      appliedStages: [],
    };
  }

  return {
    status: file.status,
    ...(file.reason === undefined ? {} : { reason: file.reason }),
    limitations: file.limitations,
    stageResults: file.stageResults,
    appliedStages: 'appliedStages' in file ? file.appliedStages : [],
    ...(file.validation === undefined ? {} : {
      validation: {
        scoreDelta: file.validation.scoreDelta,
        identifierDelta: file.validation.identifierDelta,
        hexIdentifierDelta: file.validation.hexIdentifierDelta,
        addedSignals: file.validation.addedSignals,
        removedSignals: file.validation.removedSignals,
      },
    }),
  };
}
