import { buildAgentPromptV0_2 } from './agent-prompt-v0_2';
import type { AgentAnalysisInputV0_3 } from './agent-analysis-input.contract';

const input = {
  request: { analysisRequestId: 'request', requestType: 'MALICIOUS_CODE_ANALYSIS', schemaVersion: '0.3.0', scanId: 'scan', createdAt: null },
  subject: { ecosystem: 'npm', packageName: 'fixture', packageVersion: '1.0.0', archiveSha256: 'a'.repeat(64) },
  packageContext: { source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION', description: null, main: null, exports: null, scripts: {}, dependencies: {}, entryPoints: [], lifecycleScripts: [] },
  artifactContext: { artifacts: [], findingLocations: [], evidenceLocations: [] }, findings: [], atomicEvidences: [],
  analysisPlan: { shouldExecute: true, analysisMode: 'ORIGINAL_ONLY', targets: [], focusBehaviors: [], analysisTargets: [], limitations: [] },
  analysisPolicy: { maxToolCalls: 0, maxAdditionalCodeRequests: 0, maxTotalCodeLines: 1 }, initialCodeSlices: [],
  toolResponseCatalog: [{ tool: 'GET_FILE_RANGE', status: 'UNAVAILABLE', reason: 'Offline experiment.' }], missingData: [],
} satisfies AgentAnalysisInputV0_3;

describe('buildAgentPromptV0_2', () => {
  it('keeps production code requests enabled by default', () => {
    expect(buildAgentPromptV0_2(input)).toContain('return NEEDS_ADDITIONAL_CODE');
  });

  it('can disable all additional code requests for a controlled offline experiment', () => {
    const prompt = buildAgentPromptV0_2(input, [], [], { additionalCodeRequests: 'DISABLED' });
    expect(prompt).toContain('Additional code requests are disabled for this offline experiment.');
    expect(prompt).toContain('do not return NEEDS_ADDITIONAL_CODE');
    expect(prompt).not.toContain('Request additional code only when');
  });
});
