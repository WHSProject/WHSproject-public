import { z } from 'zod';
import { agentOutputSchema } from '../output.contract';
import { AGENT_OUTPUT_SCHEMA } from '../output-schema';

/**
 * Tier 3 Agent output 0.2.0 (issue #344): the model may request additional code
 * only with an artifact-based GET_FILE_RANGE. Assessments are unchanged from
 * 0.1.0. The 0.1.0 output stays the execution path until the Runner switches
 * over together with the Runtime Tool (PR 4).
 */

export const AGENT_OUTPUT_SCHEMA_VERSION_V0_2 = '0.2.0' as const;

/** The only code request the model may emit; other tools are listed as UNAVAILABLE in the input catalog. */
export interface GetFileRangeRequest {
  /** Model-assigned request ID, kept as `agentRequestId` on the resulting RUNTIME slice. */
  id: string;
  type: 'GET_FILE_RANGE';
  target: { artifactId: string; filePath: string; startLine: number; endLine: number };
  reasonCode: string;
}

const nonempty = z.string().min(1);
const line = z.number().int().positive();

export const getFileRangeRequestSchema = z.strictObject({
  id: nonempty,
  type: z.literal('GET_FILE_RANGE'),
  target: z.strictObject({ artifactId: nonempty, filePath: nonempty, startLine: line, endLine: line })
    .refine((target) => target.endLine >= target.startLine, { message: 'endLine must not be before startLine' }),
  reasonCode: nonempty,
});

const [additionalCodeV0_1, completedV0_1] = agentOutputSchema.options;
const schemaVersion = z.literal(AGENT_OUTPUT_SCHEMA_VERSION_V0_2);

export const agentOutputSchemaV0_2 = z.discriminatedUnion('status', [
  additionalCodeV0_1.extend({ schemaVersion, requests: z.array(getFileRangeRequestSchema).min(1) }),
  completedV0_1.extend({ schemaVersion }),
]);
export type AgentAnalysisOutputV0_2 = z.infer<typeof agentOutputSchemaV0_2>;
export type CompletedAgentOutputV0_2 = Extract<AgentAnalysisOutputV0_2, { status: 'COMPLETED' }>;

/** Parses model output 0.2.0 and binds it to the analysis request it answers. */
export function parseAgentOutputV0_2(value: unknown, analysisRequestId: string): AgentAnalysisOutputV0_2 {
  const output = agentOutputSchemaV0_2.parse(value);
  if (output.requestId !== analysisRequestId) throw new Error('Agent output requestId mismatch');
  return output;
}

const lineSchema = { type: 'integer', minimum: 1 } as const;
const nonemptySchema = { type: 'string', minLength: 1 } as const;

function buildOutputJsonSchemaV0_2() {
  // Derived from 0.1.0 so assessment definitions stay identical; only the version and code request change.
  const { $defs, ...base } = AGENT_OUTPUT_SCHEMA;
  const withVersion = <T extends { properties: object }>(definition: T) => ({
    ...definition, properties: { ...definition.properties, schemaVersion: { const: AGENT_OUTPUT_SCHEMA_VERSION_V0_2 } },
  });
  return structuredClone({
    ...base,
    $id: 'https://whsproject.local/agent-analysis-output-v0.2.schema.json',
    title: 'ScannerAgentAnalysisOutputV0_2',
    $defs: {
      ...$defs,
      additionalCodeResponse: withVersion($defs.additionalCodeResponse),
      completedResponse: withVersion($defs.completedResponse),
      codeRequest: {
        type: 'object', additionalProperties: false, required: ['id', 'type', 'target', 'reasonCode'],
        properties: { id: nonemptySchema, type: { const: 'GET_FILE_RANGE' }, target: { $ref: '#/$defs/codeRequestTarget' }, reasonCode: nonemptySchema },
      },
      codeRequestTarget: {
        type: 'object', additionalProperties: false, required: ['artifactId', 'filePath', 'startLine', 'endLine'],
        properties: { artifactId: nonemptySchema, filePath: nonemptySchema, startLine: lineSchema, endLine: { ...lineSchema, description: 'Must be greater than or equal to startLine.' } },
      },
    },
  });
}

/** Model-facing JSON Schema for output 0.2.0, kept in sync with `agentOutputSchemaV0_2` by tests. */
export const AGENT_OUTPUT_SCHEMA_V0_2 = buildOutputJsonSchemaV0_2();
