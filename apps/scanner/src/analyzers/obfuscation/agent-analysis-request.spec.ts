import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AnalysisContext } from '../../domain/analysis.types';
import type { FileEvidenceBundle } from './agent-analysis.types';
import type { SelectedGptCandidate } from './evidence-bundle';
import { buildAgentAnalysisRequest } from './agent-analysis-request';
import type { RestoreResult } from './obfuscation.types';

describe('Agent analysis request restore provenance', () => {
  it('파일별 restore context를 전달하고 절대경로를 노출하지 않는다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-shadow-request-'));
    try {
      const sourcePath = join(root, 'package', 'setup.js');
      await mkdir(join(root, 'package'), { recursive: true });
      await writeFile(sourcePath, 'fetch(url);', 'utf8');

      const restore = restoreResult(sourcePath);
      const bundle: FileEvidenceBundle = {
        path: 'package/setup.js',
        restoreStatus: 'PARTIAL_RESTORED',
        appliedStages: ['STRUCTURE'],
        restoration: {
          status: 'PARTIAL_RESTORED',
          reason: 'DYNAMIC_DECODE_UNRESOLVED',
          limitations: ['DYNAMIC_DECODE_UNRESOLVED'],
          stageResults: [{
            stage: 'STRUCTURE', applied: true, status: 'COMPLETED', changed: true,
          }],
          appliedStages: ['STRUCTURE'],
          validation: {
            scoreDelta: -0.2,
            identifierDelta: 1,
            hexIdentifierDelta: -2,
            addedSignals: ['DYNAMIC_EVAL'],
            removedSignals: ['BASE64_DECODE'],
          },
        },
        evidences: [{
          evidenceId: 'TIER_2:finding-1',
          tier: 'TIER_2',
          analyzer: 'custom-rule-deobfuscated',
          ruleId: 'custom.network-outbound',
          message: 'network',
          path: 'package/setup.js',
          line: 1,
        }],
        newRuleIds: ['custom.network-outbound'],
        capabilities: ['NETWORK'],
        strongCombinations: [],
      };
      const candidate: SelectedGptCandidate = {
        path: 'package\\setup.js',
        sourcePath,
        sourceKind: 'RESTORED',
        restored: true,
        reason: 'RESTORED_WITH_NEW_SIGNAL',
        supportingReasons: ['RESTORED_WITH_NEW_SIGNAL'],
        matchedSignals: ['custom.network-outbound'],
        residualCapabilities: ['NETWORK'],
        derivedNewRuleIds: ['custom.network-outbound'],
        bundle,
      };

      const request = await buildAgentAnalysisRequest(context(root), [candidate], restore);
      expect(request?.candidates[0]).toMatchObject({
        path: 'package/setup.js',
        sourceKind: 'RESTORED',
        restoration: {
          status: 'PARTIAL_RESTORED',
          reason: 'DYNAMIC_DECODE_UNRESOLVED',
          limitations: ['DYNAMIC_DECODE_UNRESOLVED'],
          stageResults: [expect.objectContaining({ stage: 'STRUCTURE' })],
          validation: {
            scoreDelta: -0.2,
            addedSignals: ['DYNAMIC_EVAL'],
            removedSignals: ['BASE64_DECODE'],
          },
        },
      });
      expect(JSON.stringify(request)).not.toContain(root);
      expect(JSON.stringify(request)).not.toContain('\\');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function context(extractedPath: string): AnalysisContext {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    package: { name: 'fixture', version: '1.0.0' },
    artifact: {
      tarballPath: join(extractedPath, '..', 'artifact.tgz'),
      extractedPath,
      hash: 'a'.repeat(64),
    },
    metadata: {
      registryMetadata: {},
      packageJson: {
        name: 'fixture',
        version: '1.0.0',
        scripts: { postinstall: 'node package/setup.js' },
      },
    },
  };
}

function restoreResult(outputPath: string): RestoreResult {
  return {
    outputRoot: join(outputPath, '..', '..'),
    restored: [{
      path: 'package\\setup.js',
      outputPath,
      status: 'PARTIAL_RESTORED',
      reason: 'DYNAMIC_DECODE_UNRESOLVED',
      limitations: ['DYNAMIC_DECODE_UNRESOLVED'],
      stageResults: [{
        stage: 'STRUCTURE', applied: true, status: 'COMPLETED', changed: true,
      }],
      appliedStages: ['STRUCTURE'],
      payloads: [],
      originalBytes: 20,
      restoredBytes: 12,
      verifyAfter: { score: 0.2, hexIdRatio: 0.1 },
      validation: {
        original: {
          parse: { valid: true }, bytes: 20, identifierCount: 1,
          hexIdentifierCount: 2, hexIdRatio: 0.2, score: 0.4, signals: ['BASE64_DECODE'],
        },
        restored: {
          parse: { valid: true }, bytes: 12, identifierCount: 2,
          hexIdentifierCount: 0, hexIdRatio: 0, score: 0.2, signals: ['DYNAMIC_EVAL'],
        },
        byteDelta: -8,
        byteRatio: 0.6,
        identifierDelta: 1,
        hexIdentifierDelta: -2,
        scoreDelta: -0.2,
        addedSignals: ['DYNAMIC_EVAL'],
        removedSignals: ['BASE64_DECODE'],
        capability: { before: [], after: null, status: 'NOT_APPLICABLE', lost: [] },
      },
      durationMs: 1,
    }],
    unresolved: [],
    durationMs: 1,
    budgetExceeded: false,
  };
}
