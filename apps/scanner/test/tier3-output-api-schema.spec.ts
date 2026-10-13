import Ajv2020 from 'ajv/dist/2020';
import { inspectStructuredOutputSchema } from '../src/application/agent-experiment/agent-experiment-structured-output-linter';
import {
  AGENT_OUTPUT_API_SCHEMA_V0_2,
  normalizeAgentOutputV0_2ApiResponse,
  validateAgentOutputV0_2ApiBranch,
} from '../src/llm-agent/artifact/agent-output-v0_2.api-schema';
import { AGENT_OUTPUT_SCHEMA_V0_2, parseAgentOutputV0_2 } from '../src/llm-agent/artifact/agent-output-v0_2.contract';
import {
  AGENT_OUTPUT_API_SCHEMA_V0_3,
  normalizeAgentOutputV0_3ApiResponse,
  validateAgentOutputV0_3ApiBranch,
} from '../src/llm-agent/artifact/agent-output-v0_3.api-schema';
import { AGENT_OUTPUT_SCHEMA_V0_3, parseAgentOutputV0_3 } from '../src/llm-agent/artifact/agent-output-v0_3.contract';

const requestId = 'agent-analysis:test:0.3.0';
const completed = {
  requestId, schemaVersion: '0.2.0', status: 'COMPLETED', requests: null,
  assessments: [], summary: { verdict: 'INCONCLUSIVE', confidence: 0, reasonCodes: ['NO_CONTEXT'] },
  limitations: [], missingContext: [],
};
const additional = {
  requestId, schemaVersion: '0.2.0', status: 'NEEDS_ADDITIONAL_CODE',
  requests: [{ id: 'REQ-1', type: 'GET_FILE_RANGE', target: { artifactId: 'artifact:1', filePath: 'index.js', startLine: 1, endLine: 2 }, reasonCode: 'NEED_CONTEXT' }],
  assessments: null, summary: null, limitations: null, missingContext: null,
};

describe('Tier 3 Responses API output schema', () => {
  it('uses one supported closed object without mutating the domain schema', () => {
    const before = JSON.stringify(AGENT_OUTPUT_SCHEMA_V0_2);
    expect(AGENT_OUTPUT_API_SCHEMA_V0_2).toMatchObject({ type: 'object', additionalProperties: false });
    expect(AGENT_OUTPUT_API_SCHEMA_V0_2).not.toHaveProperty('oneOf');
    expect(inspectStructuredOutputSchema(AGENT_OUTPUT_API_SCHEMA_V0_2).violations).toEqual([]);
    expect(JSON.stringify(AGENT_OUTPUT_SCHEMA_V0_2)).toBe(before);
    expect(AGENT_OUTPUT_SCHEMA_V0_2).toHaveProperty('oneOf');
    expect(AGENT_OUTPUT_SCHEMA_V0_2).not.toHaveProperty('type');
  });

  it('normalizes both valid transport branches through the unchanged domain parser', () => {
    expect(() => validateAgentOutputV0_2ApiBranch(completed)).not.toThrow();
    expect(parseAgentOutputV0_2(normalizeAgentOutputV0_2ApiResponse(completed), requestId)).toMatchObject({ status: 'COMPLETED' });
    expect(() => validateAgentOutputV0_2ApiBranch(additional)).not.toThrow();
    expect(parseAgentOutputV0_2(normalizeAgentOutputV0_2ApiResponse(additional), requestId)).toMatchObject({ status: 'NEEDS_ADDITIONAL_CODE' });
  });

  it('rejects invalid branch combinations and retains domain constraints', () => {
    expect(() => validateAgentOutputV0_2ApiBranch({ ...completed, requests: [] })).toThrow('MUST_BE_ABSENT_OR_NULL');
    expect(() => validateAgentOutputV0_2ApiBranch({ ...additional, assessments: [] })).toThrow('EXCLUSIVE_FIELD');
    const request = additional.requests[0]!;
    const invalidLine = { ...additional, requests: [{ ...request, target: { ...request.target, startLine: 0 } }] };
    expect(() => parseAgentOutputV0_2(normalizeAgentOutputV0_2ApiResponse(invalidLine), requestId)).toThrow();
  });
});

describe('Tier 3 structured limitation output 0.3.0', () => {
  const validateDomainJson = new Ajv2020({ allErrors: true, strict: false }).compile(AGENT_OUTPUT_SCHEMA_V0_3);
  const assessment = {
    id: 'A-1', type: 'CORRELATED_BEHAVIOR', signal: 'ENV_READ', category: 'CREDENTIAL', basis: 'PATTERN_MATCH',
    findingIds: ['finding-1'], refs: [{ id: 'R-1', sliceId: 'SLICE-1', lines: [1, 1], role: 'SOURCE' }],
    flow: { source: 'R-1' }, reachability: { status: 'POSSIBLE' },
    verification: { status: 'UNVERIFIED', method: 'NONE' }, confidence: 0.7, reasonCodes: ['ENV_ACCESS'],
    claimScope: 'CODE_BEHAVIOR', limitations: [{ kind: 'RUNTIME_UNCONFIRMED', detail: 'No runtime observation' }],
  };
  const structured = {
    requestId, schemaVersion: '0.3.0', status: 'COMPLETED', requests: null,
    assessments: [assessment], summary: { verdict: 'SUSPICIOUS', confidence: 0.7, reasonCodes: ['ENV_ACCESS'] },
    limitations: [{ kind: 'RUNTIME_UNCONFIRMED', detail: 'Static analysis only' }],
    missingContext: [{ kind: 'CALLER_UNKNOWN', detail: 'Caller not supplied', affectedAssessmentIds: ['A-1'] }],
  };

  it('keeps the root envelope and preserves structured content through nullable normalization', () => {
    expect(AGENT_OUTPUT_API_SCHEMA_V0_3).toMatchObject({ type: 'object', additionalProperties: false });
    expect(AGENT_OUTPUT_API_SCHEMA_V0_3).not.toHaveProperty('oneOf');
    expect(inspectStructuredOutputSchema(AGENT_OUTPUT_API_SCHEMA_V0_3).violations).toEqual([]);
    expect(AGENT_OUTPUT_SCHEMA_V0_3).toHaveProperty('oneOf');
    validateAgentOutputV0_3ApiBranch(structured);
    const parsed = parseAgentOutputV0_3(normalizeAgentOutputV0_3ApiResponse(structured), requestId);
    expect(validateDomainJson(normalizeAgentOutputV0_3ApiResponse(structured))).toBe(true);
    expect(parsed).toMatchObject({
      assessments: [{ claimScope: 'CODE_BEHAVIOR', limitations: [{ kind: 'RUNTIME_UNCONFIRMED' }] }],
      missingContext: [{ kind: 'CALLER_UNKNOWN', affectedAssessmentIds: ['A-1'] }],
    });
  });

  it.each([
    ['bad kind', { ...structured, limitations: [{ kind: 'NOT_A_KIND', detail: 'bad' }] }],
    ['bad scope', { ...structured, assessments: [{ ...assessment, claimScope: 'RUNTIME_SUCCESS' }] }],
    ['missing scope', { ...structured, assessments: [{ ...assessment, claimScope: undefined }] }],
    ['mixed legacy limitation', { ...structured, assessments: [{ ...assessment, limitations: ['legacy text'] }] }],
  ])('rejects %s instead of falling back to legacy semantics', (_name, value) => {
    expect(() => parseAgentOutputV0_3(normalizeAgentOutputV0_3ApiResponse(value), requestId)).toThrow();
  });

  it('rejects an unknown affected assessment ID as a response contract error', () => {
    const invalid = { ...structured, missingContext: [{ kind: 'CALLER_UNKNOWN', detail: 'Caller absent', affectedAssessmentIds: ['A-NOT-THERE'] }] };
    expect(() => parseAgentOutputV0_3(normalizeAgentOutputV0_3ApiResponse(invalid), requestId)).toThrow('Unknown affected assessment ID');
  });

  it('rejects an empty affected assessment ID list in the unchanged domain contract', () => {
    const invalid = { ...structured, missingContext: [{ kind: 'CODE_MISSING', detail: 'Finding finding-2 lacks its source range', affectedAssessmentIds: [] }] };
    const normalized = normalizeAgentOutputV0_3ApiResponse(invalid);
    expect(validateDomainJson(normalized)).toBe(false);
    expect(validateDomainJson.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ instancePath: '/missingContext/0/affectedAssessmentIds', keyword: 'minItems' }),
    ]));
    expect(() => parseAgentOutputV0_3(normalized, requestId)).toThrow(/expected array to have >=1 items/);
  });

  it('does not reinterpret a legacy free-text response as output 0.3.0', () => {
    expect(() => parseAgentOutputV0_3(completed, requestId)).toThrow();
    expect(parseAgentOutputV0_2(normalizeAgentOutputV0_2ApiResponse(completed), requestId).schemaVersion).toBe('0.2.0');
  });
});
