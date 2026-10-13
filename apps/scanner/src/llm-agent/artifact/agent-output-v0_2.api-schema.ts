import { strictApiProjection, stripNullProperties } from '../strict-api-projection';
import { AGENT_OUTPUT_SCHEMA_V0_2 } from './agent-output-v0_2.contract';

type JsonObject = Record<string, unknown>;
const domainSchema = AGENT_OUTPUT_SCHEMA_V0_2 as JsonObject;
const definitions = domainSchema.$defs as JsonObject;
const completed = definitions.completedResponse as JsonObject;
const completedProperties = completed.properties as JsonObject;

/**
 * API transport envelope for Tier 3 input V0.3 / output V0.2. The unchanged
 * domain contract remains a discriminated union; the API root is one object.
 */
const transportEnvelope = {
  type: 'object', additionalProperties: false,
  required: ['requestId', 'schemaVersion', 'status', 'requests', 'assessments', 'summary', 'limitations', 'missingContext'],
  properties: {
    requestId: structuredClone(completedProperties.requestId),
    schemaVersion: structuredClone(completedProperties.schemaVersion),
    status: { type: 'string', enum: ['COMPLETED', 'NEEDS_ADDITIONAL_CODE'] },
    requests: { type: ['array', 'null'], items: { $ref: '#/$defs/codeRequest' } },
    assessments: { type: ['array', 'null'], items: { $ref: '#/$defs/assessment' } },
    summary: { ...(structuredClone(definitions.summary as JsonObject)), type: ['object', 'null'] },
    limitations: { type: ['array', 'null'], items: { type: 'string' } },
    missingContext: { type: ['array', 'null'], items: { type: 'string' } },
  },
  $defs: Object.fromEntries(Object.entries(definitions)
    .filter(([key]) => !['additionalCodeResponse', 'completedResponse', 'summary'].includes(key))),
};

/** API-facing schema only; `AGENT_OUTPUT_SCHEMA_V0_2` is never mutated. */
export const AGENT_OUTPUT_API_SCHEMA_V0_2 = strictApiProjection(transportEnvelope) as JsonObject;

export function normalizeAgentOutputV0_2ApiResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return stripNullProperties(value);
}

/** Enforces status/branch meaning before nullable transport fields are removed. */
export function validateAgentOutputV0_2ApiBranch(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AGENT_OUTPUT_API_ROOT_OBJECT_REQUIRED');
  const output = value as JsonObject;
  if (output.status === 'COMPLETED') {
    if (output.requests !== null && output.requests !== undefined) throw new Error('AGENT_OUTPUT_API_COMPLETED_REQUESTS_MUST_BE_ABSENT_OR_NULL');
    for (const field of ['assessments', 'summary', 'limitations', 'missingContext']) {
      if (output[field] === null) throw new Error(`AGENT_OUTPUT_API_COMPLETED_FIELD_NULL:${field}`);
    }
    return;
  }
  if (output.status === 'NEEDS_ADDITIONAL_CODE') {
    if (output.requests === null || output.requests === undefined) throw new Error('AGENT_OUTPUT_API_CODE_REQUESTS_REQUIRED');
    for (const field of ['assessments', 'summary', 'limitations', 'missingContext']) {
      if (output[field] !== null && output[field] !== undefined) throw new Error(`AGENT_OUTPUT_API_CODE_REQUEST_EXCLUSIVE_FIELD:${field}`);
    }
    return;
  }
  throw new Error('AGENT_OUTPUT_API_STATUS_UNKNOWN');
}
