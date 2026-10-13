import { z } from 'zod';
import { assessmentSchema } from '../output.contract';
import {
  AGENT_OUTPUT_SCHEMA_V0_2,
  getFileRangeRequestSchema,
  type GetFileRangeRequest,
} from './agent-output-v0_2.contract';

export const AGENT_OUTPUT_SCHEMA_VERSION_V0_3 = '0.3.0' as const;

export const CLAIM_SCOPES = ['CODE_BEHAVIOR', 'STATIC_REACHABILITY'] as const;
export const LIMITATION_KINDS = [
  'CODE_MISSING', 'BINDING_UNKNOWN', 'DATA_FLOW_UNKNOWN', 'CALLER_UNKNOWN',
  'RESTORE_UNCERTAIN', 'PAYLOAD_UNKNOWN', 'INTENT_UNKNOWN', 'RUNTIME_UNCONFIRMED', 'OTHER',
] as const;

const nonempty = z.string().min(1);
export const structuredLimitationSchema = z.strictObject({
  kind: z.enum(LIMITATION_KINDS),
  detail: nonempty,
});
export const structuredMissingContextSchema = structuredLimitationSchema.extend({
  affectedAssessmentIds: z.array(nonempty).min(1)
    .refine((ids) => new Set(ids).size === ids.length, 'affectedAssessmentIds must be unique')
    .optional(),
});
export const assessmentSchemaV0_3 = assessmentSchema.omit({ limitations: true }).extend({
  claimScope: z.enum(CLAIM_SCOPES),
  limitations: z.array(structuredLimitationSchema),
});

const summarySchema = z.strictObject({
  verdict: z.enum(['NO_MALICIOUS_BEHAVIOR_FOUND', 'SUSPICIOUS', 'LIKELY_MALICIOUS', 'INCONCLUSIVE']),
  confidence: z.number().min(0).max(1),
  reasonCodes: z.array(nonempty).min(1).refine((ids) => new Set(ids).size === ids.length),
});
const additionalCodeSchemaV0_3 = z.strictObject({
  requestId: nonempty,
  schemaVersion: z.literal(AGENT_OUTPUT_SCHEMA_VERSION_V0_3),
  status: z.literal('NEEDS_ADDITIONAL_CODE'),
  requests: z.array(getFileRangeRequestSchema).min(1),
});
const completedSchemaV0_3 = z.strictObject({
  requestId: nonempty,
  schemaVersion: z.literal(AGENT_OUTPUT_SCHEMA_VERSION_V0_3),
  status: z.literal('COMPLETED'),
  assessments: z.array(assessmentSchemaV0_3),
  summary: summarySchema,
  limitations: z.array(structuredLimitationSchema),
  missingContext: z.array(structuredMissingContextSchema),
}).superRefine((output, context) => {
  const ids = new Set(output.assessments.map(({ id }) => id));
  output.missingContext.forEach((item, itemIndex) => item.affectedAssessmentIds?.forEach((id, idIndex) => {
    if (!ids.has(id)) context.addIssue({
      code: 'custom', path: ['missingContext', itemIndex, 'affectedAssessmentIds', idIndex],
      message: `Unknown affected assessment ID: ${id}`,
    });
  }));
});

export const agentOutputSchemaV0_3 = z.discriminatedUnion('status', [additionalCodeSchemaV0_3, completedSchemaV0_3]);
export type AgentAnalysisOutputV0_3 = z.infer<typeof agentOutputSchemaV0_3>;
export type CompletedAgentOutputV0_3 = Extract<AgentAnalysisOutputV0_3, { status: 'COMPLETED' }>;
export type AgentAssessmentV0_3 = z.infer<typeof assessmentSchemaV0_3>;
export type StructuredLimitation = z.infer<typeof structuredLimitationSchema>;
export type StructuredMissingContext = z.infer<typeof structuredMissingContextSchema>;
export type { GetFileRangeRequest };

export function parseAgentOutputV0_3(value: unknown, analysisRequestId: string): AgentAnalysisOutputV0_3 {
  const output = agentOutputSchemaV0_3.parse(value);
  if (output.requestId !== analysisRequestId) throw new Error('Agent output requestId mismatch');
  return output;
}

type JsonObject = Record<string, any>;

/** Output 0.3.0 deliberately keeps the 0.2.0 root/branch shape and changes only completed-output limitations. */
function buildOutputJsonSchemaV0_3(): JsonObject {
  const schema = structuredClone(AGENT_OUTPUT_SCHEMA_V0_2) as JsonObject;
  schema.$id = 'https://whsproject.local/agent-analysis-output-v0.3.schema.json';
  schema.title = 'ScannerAgentAnalysisOutputV0_3';
  const defs = schema.$defs as JsonObject;
  const limitation = {
    type: 'object', additionalProperties: false, required: ['kind', 'detail'],
    properties: { kind: { type: 'string', enum: [...LIMITATION_KINDS] }, detail: { type: 'string', minLength: 1 } },
  };
  defs.structuredLimitation = limitation;
  defs.structuredMissingContext = {
    type: 'object', additionalProperties: false, required: ['kind', 'detail'],
    properties: {
      ...structuredClone(limitation.properties),
      affectedAssessmentIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    },
  };
  defs.assessment.required = [...defs.assessment.required, 'claimScope', 'limitations'];
  defs.assessment.properties.claimScope = { type: 'string', enum: [...CLAIM_SCOPES] };
  defs.assessment.properties.limitations = { type: 'array', items: { $ref: '#/$defs/structuredLimitation' } };
  for (const branch of ['additionalCodeResponse', 'completedResponse']) defs[branch].properties.schemaVersion = { const: AGENT_OUTPUT_SCHEMA_VERSION_V0_3 };
  defs.completedResponse.properties.limitations = { type: 'array', items: { $ref: '#/$defs/structuredLimitation' } };
  defs.completedResponse.properties.missingContext = { type: 'array', items: { $ref: '#/$defs/structuredMissingContext' } };
  return schema;
}

export const AGENT_OUTPUT_SCHEMA_V0_3 = buildOutputJsonSchemaV0_3();
