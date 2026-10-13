import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';

import { AGENT_EXPERIMENT_OUTPUT_SCHEMA, AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256, AGENT_EXPERIMENT_OUTPUT_SCHEMA_VERSION } from './agent-experiment-output.schema';
import { createStructuredOutputProbePlan, createStructuredOutputProbeSchemas, inspectStructuredOutputSchema } from './agent-experiment-structured-output-linter';

export type AgentExperimentProbeId = 'P0'|'P1'|'P2'|'P3'|'P4'|'P5'|'P6';
export interface AgentExperimentProbeDefinition {
  probeId: AgentExperimentProbeId; parentProbeId: AgentExperimentProbeId|null; purpose: string; schemaVersion: string;
  schema: Record<string,unknown>; schemaBytes: number; schemaSha256: string; instruction: string; instructionSha256: string;
  validate(value:unknown): { valid:boolean; errors:string[] };
}

const ids:AgentExperimentProbeId[]=['P0','P1','P2','P3','P4','P5','P6'];
const schemas=createStructuredOutputProbeSchemas(AGENT_EXPERIMENT_OUTPUT_SCHEMA);
const plan=createStructuredOutputProbePlan(AGENT_EXPERIMENT_OUTPUT_SCHEMA);
const instructions=[
  'Return one JSON object with requestId set to probe-request.',
  'Return one JSON object with requestId probe-request and status COMPLETED.',
  'Return one JSON object with requestId probe-request, schemaVersion 0.1.0, and status COMPLETED.',
  'Return a minimal JSON object matching the schema. Use status COMPLETED and a summary with verdict INCONCLUSIVE, confidence 0, and reasonCodes containing NO_ASSESSMENTS.',
  'Return a minimal JSON object matching the schema. Use status COMPLETED, the same minimal summary, and an empty assessments array.',
  'Return a minimal JSON object matching the schema. Use status COMPLETED, requests null, the same minimal summary, and an empty assessments array.',
  'Return a minimal JSON object matching the schema using only the COMPLETED branch: requestId probe-request, schemaVersion 0.1.0, status COMPLETED, requests null, assessments empty, summary verdict INCONCLUSIVE with confidence 0 and reasonCodes containing NO_ASSESSMENTS, limitations empty, and missingContext empty.',
];

export const AGENT_EXPERIMENT_PROBE_REGISTRY:ReadonlyMap<AgentExperimentProbeId,AgentExperimentProbeDefinition>=new Map(ids.map((probeId,index)=>{
  const schema=schemas[index]!, metadata=plan[index]!, serialized=JSON.stringify(schema), lint=inspectStructuredOutputSchema(schema);
  if(!lint.validForConfiguredSubset)throw new Error(`PROBE_SCHEMA_LINT_FAILED:${probeId}`);
  if(Buffer.byteLength(serialized)!==metadata.schemaBytes||sha(serialized)!==metadata.schemaSha256)throw new Error(`PROBE_SCHEMA_PIN_MISMATCH:${probeId}`);
  if(probeId==='P6'&&(schema!==AGENT_EXPERIMENT_OUTPUT_SCHEMA||metadata.schemaSha256!==AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256))throw new Error('P6_SCHEMA_IDENTITY_MISMATCH');
  const ajv=new Ajv2020({allErrors:true,strict:false}),validate=ajv.compile(schema),instruction=instructions[index]!;
  return[probeId,{probeId,parentProbeId:metadata.parentProbeId as AgentExperimentProbeId|null,purpose:metadata.expectedPurpose,schemaVersion:AGENT_EXPERIMENT_OUTPUT_SCHEMA_VERSION,
    schema,schemaBytes:metadata.schemaBytes,schemaSha256:metadata.schemaSha256,instruction,instructionSha256:sha(instruction),validate(value:unknown){const valid=Boolean(validate(value));return{valid,errors:valid?[]:(validate.errors??[]).map(e=>`${e.instancePath||'/'}:${e.keyword}:${e.message??'invalid'}`)}}}];
}));

export function getAgentExperimentProbe(probeId:string):AgentExperimentProbeDefinition {
  const probe=AGENT_EXPERIMENT_PROBE_REGISTRY.get(probeId as AgentExperimentProbeId);if(!probe)throw new Error(`UNKNOWN_PROBE_ID:${probeId}`);return probe;
}
function sha(value:string):string{return createHash('sha256').update(value).digest('hex');}
