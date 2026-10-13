import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { AtomicEvidenceV0_1 } from '../../../src/evidence/normalizer/evidence-normalizer.types';
import type { Tier3ExecutionInput, Tier3FindingProjection } from '../../../src/llm-agent/artifact/agent-analysis-input.contract';
import { toPackageContextV0_3 } from '../../../src/llm-agent/artifact/agent-input-v0_3.builder';
import type {
  ArtifactDescriptor,
  ArtifactResolver,
  ValidatedAgentAnalysisPlan,
  ValidatedPlanningTarget,
} from '../../../src/llm-agent/artifact/artifact.contract';
import { projectPackageContext } from '../../../src/llm-agent/llm-agent-input-builder.service';

/**
 * Mock Tier 2 handoff and Planning output for Tier 3 development before the real
 * handoffs exist (issue #340). Both artifacts contain `install.js`, so the same
 * file path must still resolve to different code by artifactId.
 */

export const FIXTURE_ROOT = join(__dirname);
export const ORIGINAL_ARTIFACT_ID = 'ARTIFACT-ORIGINAL-001';
export const DEOBFUSCATED_ARTIFACT_ID = 'ARTIFACT-DEOBFUSCATED-001';

function treeSha256(root: string): string {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  const hash = createHash('sha256');
  for (const file of files.map((path) => relative(root, path).split(sep).join('/')).sort()) {
    hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
  }
  return hash.digest('hex');
}

/** Test resolver over fixed directories; roots stay out of every descriptor. */
export class StaticArtifactResolver implements ArtifactResolver {
  private readonly entries: Map<string, { descriptor: ArtifactDescriptor; root: string }>;

  constructor(entries: Array<{ descriptor: ArtifactDescriptor; root: string }>) {
    this.entries = new Map(entries.map((entry) => [entry.descriptor.artifactId, entry]));
  }

  describe(artifactId: string): ArtifactDescriptor | undefined {
    return this.entries.get(artifactId)?.descriptor;
  }

  list(): readonly ArtifactDescriptor[] {
    return [...this.entries.values()].map((entry) => entry.descriptor);
  }

  async resolveRoot(artifactId: string): Promise<string> {
    const entry = this.entries.get(artifactId);
    if (!entry) throw new Error('Unknown artifact');
    return entry.root;
  }
}

export function createMockArtifactResolver(): StaticArtifactResolver {
  const originalRoot = join(FIXTURE_ROOT, 'original');
  const deobfuscatedRoot = join(FIXTURE_ROOT, 'deobfuscated');
  return new StaticArtifactResolver([
    {
      root: originalRoot,
      descriptor: {
        artifactId: ORIGINAL_ARTIFACT_ID, representation: 'ORIGINAL', analysisPass: 'TIER1',
        contentSha256: treeSha256(originalRoot), lineageStatus: 'DIRECT', producer: 'safe-extract',
      },
    },
    {
      root: deobfuscatedRoot,
      descriptor: {
        artifactId: DEOBFUSCATED_ARTIFACT_ID, representation: 'DEOBFUSCATED', analysisPass: 'TIER2',
        contentSha256: treeSha256(deobfuscatedRoot), derivedFromArtifactId: ORIGINAL_ARTIFACT_ID,
        lineageStatus: 'UNMAPPED', producer: 'webcrack+babel', producerVersion: 'mock',
      },
    },
  ]);
}

function plan(planId: string, analysisMode: ValidatedAgentAnalysisPlan['analysisMode'], targets: ValidatedPlanningTarget[]): ValidatedAgentAnalysisPlan {
  return {
    planId, shouldExecute: true, analysisMode, targets,
    focusBehaviors: ['ENVIRONMENT_ACCESS'], analysisTargets: [], limitations: [],
    validation: { status: 'VALIDATED' },
  };
}

/** ORIGINAL artifact, Tier 1 Finding/Evidence, ORIGINAL_ONLY plan. */
export const originalOnlyPlan = plan('PLAN-ORIGINAL-ONLY', 'ORIGINAL_ONLY', [
  {
    targetId: 'TARGET-001', artifactId: ORIGINAL_ARTIFACT_ID, filePath: 'install.js',
    priority: 'HIGH', findingRefs: ['tier1:env-read:1'], evidenceRefs: ['AE-TIER1-001'], reasonCodes: ['LIFECYCLE_ENTRY'],
  },
]);

/** ORIGINAL and DEOBFUSCATED artifacts, Tier 2 Finding/Evidence, DEOBFUSCATED_ONLY plan. */
export const deobfuscatedOnlyPlan = plan('PLAN-DEOBFUSCATED-ONLY', 'DEOBFUSCATED_ONLY', [
  {
    targetId: 'TARGET-001', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js',
    preferredRange: { startLine: 17, endLine: 18 }, priority: 'HIGH',
    findingRefs: ['tier2:env-read:1'], evidenceRefs: ['AE-TIER2-001'], reasonCodes: ['ENV_ACCESS_IN_RESTORED_CODE'],
  },
]);

/** Same filePath in both artifacts, ORIGINAL_AND_DEOBFUSCATED plan. */
export const originalAndDeobfuscatedPlan = plan('PLAN-BOTH', 'ORIGINAL_AND_DEOBFUSCATED', [
  {
    targetId: 'TARGET-001', artifactId: ORIGINAL_ARTIFACT_ID, filePath: 'install.js',
    priority: 'HIGH', findingRefs: ['tier1:env-read:1'], evidenceRefs: ['AE-TIER1-001'], reasonCodes: ['LIFECYCLE_ENTRY'],
  },
  {
    targetId: 'TARGET-002', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js',
    priority: 'HIGH', findingRefs: ['tier2:env-read:1'], evidenceRefs: ['AE-TIER2-001'], reasonCodes: ['ENV_ACCESS_IN_RESTORED_CODE'],
  },
]);

export const MOCK_SCAN_ID = 'scan-tier3-fixture';
export const MOCK_ARCHIVE_SHA256 = 'a'.repeat(64);

const findingById: Record<string, Tier3FindingProjection> = {
  'tier1:env-read:1': {
    findingId: 'tier1:env-read:1', analyzer: 'custom-rule', analyzerVersion: '1', ruleId: 'custom.env-read', kind: 'CAPABILITY',
    description: 'Environment variable access', location: { file: 'install.js', startLine: 8, endLine: 8 }, rawMatch: 'process[_0x5e(1)]',
  },
  'tier2:env-read:1': {
    findingId: 'tier2:env-read:1', analyzer: 'custom-rule-deobfuscated', analyzerVersion: '1', ruleId: 'custom.env-read', kind: 'CAPABILITY',
    description: 'Environment variable access in restored code', location: { file: 'install.js', startLine: 17, endLine: 17 }, rawMatch: 'process.env.HOME',
  },
};

const bindingByFinding: Record<string, { artifactId: string; evidenceId: string; line: number }> = {
  'tier1:env-read:1': { artifactId: ORIGINAL_ARTIFACT_ID, evidenceId: 'AE-TIER1-001', line: 8 },
  'tier2:env-read:1': { artifactId: DEOBFUSCATED_ARTIFACT_ID, evidenceId: 'AE-TIER2-001', line: 17 },
};

function atomicEvidence(evidenceId: string, findingId: string, line: number): AtomicEvidenceV0_1 {
  return {
    schemaVersion: '0.1', evidenceId, kind: 'ATOMIC',
    signal: { id: 'custom.env-read', type: 'ENV_READ', category: 'CREDENTIAL' },
    subject: { ecosystem: 'npm', packageName: 'tier3-fixture', packageVersion: '1.0.0', artifactHash: MOCK_ARCHIVE_SHA256 },
    assertion: { summary: 'Environment variable access was detected.', basis: 'PATTERN_MATCH' },
    sources: [{ analyzer: 'custom-rule', analyzerVersion: '1', ruleId: 'custom.env-read', rawFindingId: findingId }],
    locations: [{ type: 'SOURCE_FILE', path: 'install.js', startLine: line, endLine: line }],
    provenance: { scanId: MOCK_SCAN_ID, generatedBy: 'EVIDENCE_NORMALIZER', observedAt: '2026-09-25T00:00:00.000Z' },
    limitations: ['Static detection does not prove runtime behavior.'],
  };
}

/** Mock Tier 2 handoff + validated plan: only the Findings/Evidence the plan refers to are included. */
export function mockExecutionInput(plan: ValidatedAgentAnalysisPlan, resolver: ArtifactResolver = createMockArtifactResolver()): Tier3ExecutionInput {
  const findingIds = [...new Set(plan.targets.flatMap((target) => target.findingRefs))];
  const manifest = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'original', 'package.json'), 'utf8')) as Record<string, unknown>;
  return {
    validatedPlan: plan,
    artifacts: resolver,
    findings: findingIds.map((id) => findingById[id]!),
    atomicEvidences: findingIds.map((id) => atomicEvidence(bindingByFinding[id]!.evidenceId, id, bindingByFinding[id]!.line)),
    bindings: {
      findingBindings: findingIds.map((id) => ({ findingId: id, artifactId: bindingByFinding[id]!.artifactId, filePath: 'install.js', startLine: bindingByFinding[id]!.line, endLine: bindingByFinding[id]!.line })),
      evidenceBindings: findingIds.map((id) => ({ evidenceId: bindingByFinding[id]!.evidenceId, artifactId: bindingByFinding[id]!.artifactId, filePath: 'install.js', startLine: bindingByFinding[id]!.line, endLine: bindingByFinding[id]!.line })),
    },
    packageContext: toPackageContextV0_3(projectPackageContext(manifest)),
  };
}
