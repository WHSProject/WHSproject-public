import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';

import { AGENT_OUTPUT_SCHEMA } from '../../llm-agent/output-schema';

export const AGENT_EXPERIMENT_OUTPUT_SCHEMA_VERSION = 'scanner-agent-experiment-output/1.2.0' as const;

type JsonObject = Record<string, unknown>;
const source = AGENT_OUTPUT_SCHEMA as JsonObject;
const defs = structuredClone(source.$defs as JsonObject);
const completed = defs.completedResponse as JsonObject;
const completedProperties = completed.properties as JsonObject;

function legacyNullable(schema: JsonObject): JsonObject {
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'] };
  if (Array.isArray(schema.type) && schema.type.includes('null')) return schema;
  return { anyOf: [schema, { type: 'null' }] };
}

function legacyApiProjection(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(legacyApiProjection);
  if (!schema || typeof schema !== 'object') return schema;
  const input = schema as JsonObject, output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (['$schema', '$id', 'title', 'description', 'minLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems', 'prefixItems'].includes(key)) continue;
    output[key] = legacyApiProjection(value);
  }
  if (input.type === 'array' && Array.isArray(input.prefixItems)) {
    output.items = legacyApiProjection(input.prefixItems[0]);
  }
  if (input.type === 'object' && input.properties && typeof input.properties === 'object') {
    const properties = input.properties as JsonObject, originallyRequired = new Set(Array.isArray(input.required) ? input.required as string[] : []);
    output.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
      const projected = legacyApiProjection(value) as JsonObject;
      return [key, originallyRequired.has(key) ? projected : legacyNullable(projected)];
    }));
    output.required = Object.keys(properties);
    output.additionalProperties = false;
  }
  return output;
}

/**
 * Responses Structured Outputs requires a root object rather than the production
 * discriminated union. Branch-only fields are nullable here; the unchanged Zod
 * parser remains the semantic authority after null branch fields are removed.
 */
const transportEnvelope = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://whsproject.local/scanner-agent-experiment-output.v1.schema.json',
  title: 'ScannerAgentExperimentOutputV1',
  type: 'object',
  additionalProperties: false,
  required: ['requestId', 'schemaVersion', 'status', 'requests', 'assessments', 'summary', 'limitations', 'missingContext'],
  properties: {
    requestId: structuredClone(completedProperties.requestId),
    schemaVersion: structuredClone(completedProperties.schemaVersion),
    status: { type: 'string', enum: ['COMPLETED', 'NEEDS_ADDITIONAL_CODE'], description: 'Select exactly one branch. The semantic branch validator is authoritative.' },
    requests: { type: ['array', 'null'], minItems: 1, items: { $ref: '#/$defs/codeRequest' }, description: 'NEEDS_ADDITIONAL_CODE only: non-empty array. Must be null when status is COMPLETED.' },
    assessments: { type: ['array', 'null'], items: { $ref: '#/$defs/assessment' }, description: 'COMPLETED only: array. Must be null when status is NEEDS_ADDITIONAL_CODE.' },
    summary: { ...(structuredClone(defs.summary as JsonObject)), type: ['object', 'null'], description: 'COMPLETED only: summary object. Must be null when status is NEEDS_ADDITIONAL_CODE.' },
    limitations: { type: ['array', 'null'], items: { type: 'string' }, description: 'COMPLETED only: array of limitations. Must be null when status is NEEDS_ADDITIONAL_CODE.' },
    missingContext: { type: ['array', 'null'], items: { type: 'string' }, description: 'COMPLETED only: array. Must be null when status is NEEDS_ADDITIONAL_CODE; missing code must be expressed only in requests.' },
  },
  $defs: Object.fromEntries(Object.entries(defs).filter(([key]) => !['additionalCodeResponse', 'completedResponse', 'summary'].includes(key))),
};

/** Retained only for deterministic static diagnosis of the rejected v1.0.0 schema. */
export const AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0 = legacyApiProjection(transportEnvelope) as JsonObject;
export const AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0_SHA256 = createHash('sha256')
  .update(JSON.stringify(AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0)).digest('hex');

const REMOVED_API_KEYWORDS = new Set(['$schema', '$id', 'title', 'nullable', 'default', 'examples', 'deprecated',
  'readOnly', 'writeOnly', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'minItems',
  'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'propertyNames', 'patternProperties', 'unevaluatedProperties',
  'unevaluatedItems', 'contains', 'minContains', 'maxContains', 'allOf', 'not', 'if', 'then', 'else', 'dependentRequired',
  'dependentSchemas']);

function canonicalNullable(schema: JsonObject): JsonObject {
  return { anyOf: [schema, { type: 'null' }] };
}

function strictApiProjection(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictApiProjection);
  if (!schema || typeof schema !== 'object') return schema;
  const input = schema as JsonObject, output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (REMOVED_API_KEYWORDS.has(key) || key === 'prefixItems' || key === 'const') continue;
    if (key === 'type' && Array.isArray(value)) continue;
    output[key] = strictApiProjection(value);
  }
  if ('const' in input) output.enum = [input.const];
  if (input.type === 'array' && Array.isArray(input.prefixItems)) output.items = strictApiProjection(input.prefixItems[0]);
  if (Array.isArray(input.type)) {
    const nonNull = input.type.filter((type) => type !== 'null');
    if (nonNull.length !== 1) throw new Error('EXPERIMENT_SCHEMA_TYPE_UNION_UNSUPPORTED');
    const branch = strictApiProjection({ ...input, type: nonNull[0] }) as JsonObject;
    return canonicalNullable(branch);
  }
  if (input.type === 'object' && input.properties && typeof input.properties === 'object') {
    const properties = input.properties as JsonObject, originallyRequired = new Set(Array.isArray(input.required) ? input.required as string[] : []);
    output.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
      const projected = strictApiProjection(value) as JsonObject;
      return [key, originallyRequired.has(key) ? projected : canonicalNullable(projected)];
    }));
    output.required = Object.keys(properties);
    output.additionalProperties = false;
  }
  return output;
}

export const AGENT_EXPERIMENT_OUTPUT_SCHEMA = strictApiProjection(transportEnvelope) as JsonObject;

export const AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256 = createHash('sha256')
  .update(JSON.stringify(AGENT_EXPERIMENT_OUTPUT_SCHEMA)).digest('hex');

const validateApiOutput = new Ajv2020({ allErrors: true, strict: false })
  .compile(AGENT_EXPERIMENT_OUTPUT_SCHEMA);

export function validateAgentExperimentApiOutput(value: unknown): string[] {
  if (validateApiOutput(value)) return [];
  return (validateApiOutput.errors ?? []).map(({ instancePath, keyword, message }) =>
    `${instancePath || '/'}:${keyword}:${message ?? 'schema validation failed'}`);
}

export function validateAgentExperimentOutputBranch(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EXPERIMENT_OUTPUT_ROOT_OBJECT_REQUIRED');
  const output = value as JsonObject;
  if (output.status === 'COMPLETED') {
    if (output.requests !== null) throw new Error('EXPERIMENT_COMPLETED_REQUESTS_MUST_BE_NULL');
    for (const field of ['assessments', 'summary', 'limitations', 'missingContext']) if (output[field] === null) throw new Error(`EXPERIMENT_COMPLETED_FIELD_NULL:${field}`);
    return;
  }
  if (output.status === 'NEEDS_ADDITIONAL_CODE') {
    if (output.requests === null) throw new Error('EXPERIMENT_CODE_REQUESTS_REQUIRED');
    for (const field of ['assessments', 'summary', 'limitations', 'missingContext']) if (output[field] !== null) throw new Error(`EXPERIMENT_CODE_REQUEST_EXCLUSIVE_FIELD:${field}`);
    return;
  }
  throw new Error('EXPERIMENT_OUTPUT_STATUS_UNKNOWN');
}

export function normalizeAgentExperimentApiOutput(value: unknown): unknown {
  validateAgentExperimentOutputBranch(value);
  const output = value as JsonObject;
  const common = { requestId: output.requestId, schemaVersion: output.schemaVersion, status: output.status };
  if (output.status === 'COMPLETED') {
    return stripNestedNulls({ ...common, assessments: output.assessments, summary: output.summary, limitations: output.limitations, missingContext: output.missingContext });
  }
  if (output.status === 'NEEDS_ADDITIONAL_CODE') {
    return stripNestedNulls({ ...common, requests: output.requests });
  }
  throw new Error('EXPERIMENT_OUTPUT_STATUS_UNKNOWN');
}

function stripNestedNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNestedNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as JsonObject).filter(([, item]) => item !== null).map(([key, item]) => [key, stripNestedNulls(item)]));
}
