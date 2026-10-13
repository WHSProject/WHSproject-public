import Ajv2020 from 'ajv/dist/2020';

import { AGENT_EXPERIMENT_OUTPUT_SCHEMA, AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256,
  AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0, AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0_SHA256,
  AGENT_EXPERIMENT_OUTPUT_SCHEMA_VERSION, normalizeAgentExperimentApiOutput, validateAgentExperimentOutputBranch } from '../src/application/agent-experiment/agent-experiment-output.schema';
import { createStructuredOutputProbePlan, inspectStructuredOutputSchema } from '../src/application/agent-experiment/agent-experiment-structured-output-linter';
import { AgentOutputValidatorService } from '../src/llm-agent/agent-output-validator.service';

const completed={requestId:'request-1',schemaVersion:'0.1.0',status:'COMPLETED',requests:null,assessments:[],summary:{verdict:'INCONCLUSIVE',confidence:0,reasonCodes:['NO_ASSESSMENTS']},limitations:[],missingContext:[]};
const needs={requestId:'request-1',schemaVersion:'0.1.0',status:'NEEDS_ADDITIONAL_CODE',requests:[{id:'r',type:'GET_FILE_RANGE',target:{file:'index.js',symbol:null,lines:[1,2]},reasonCode:'MISSING_CONTEXT',maxLines:2}],assessments:null,summary:null,limitations:null,missingContext:null};

describe('experiment Structured Outputs subset linter',()=>{
  it('reports deterministic v1.0.0 paths without treating property names as keywords',()=>{
    const a=inspectStructuredOutputSchema(AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0),b=inspectStructuredOutputSchema(AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0);
    expect(a).toEqual(b);expect(AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0_SHA256).toBe('9d586238a59bb0201f5af59f32aa6af0ad924b36cfd3aaf3603dec06a6c14286');
    expect(a.violations.some(x=>x.jsonPath==='$.properties.requests.type'&&x.rule==='TYPE_ARRAY_FORBIDDEN_BY_CONFIGURED_SUBSET')).toBe(true);
    expect(a.keywordInventory.some(x=>x.keyword==='requestId')).toBe(false);
  });
  it('finds object, required, anyOf, reference, tuple and unsupported keyword violations at nested paths',()=>{
    const report=inspectStructuredOutputSchema({type:'object',properties:{x:{anyOf:[{type:'object',properties:{value:{type:['string','null'],minLength:1}},required:[],prefixItems:[]},{type:'null'}]},y:{$ref:'https://example.invalid/schema'}},required:['x'],additionalProperties:true});
    for(const rule of ['OBJECT_MUST_BE_CLOSED','ALL_PROPERTIES_REQUIRED','TYPE_ARRAY_FORBIDDEN_BY_CONFIGURED_SUBSET','KEYWORD_FORBIDDEN','EXTERNAL_REF_FORBIDDEN'])expect(report.violations.some(x=>x.rule===rule)).toBe(true);
    expect(report.violations.some(x=>x.jsonPath.includes('properties.x.anyOf[0]'))).toBe(true);
  });
  it('calculates complexity from root depth one and builds a deterministic seven-step probe plan',()=>{
    const report=inspectStructuredOutputSchema(AGENT_EXPERIMENT_OUTPUT_SCHEMA),plan=createStructuredOutputProbePlan(AGENT_EXPERIMENT_OUTPUT_SCHEMA);
    expect(report.metrics).toMatchObject({maximumNestingDepth:5,totalPropertyCount:55,totalRequiredEntryCount:55,totalEnumValueCount:52,objectNodeCount:10,arrayNodeCount:18,anyOfNodeCount:23,nullablePropertyCount:23});
    expect(plan).toHaveLength(7);expect(plan.map(x=>x.probeId)).toEqual(['P0','P1','P2','P3','P4','P5','P6']);expect(plan.every(x=>x.maxCalls===1)).toBe(true);
  });
});

describe('experiment output schema v1.2.0',()=>{
  const validate=new Ajv2020({allErrors:true,strict:false}).compile(AGENT_EXPERIMENT_OUTPUT_SCHEMA);
  it('is a deterministic canonical strict-subset schema',()=>{
    const report=inspectStructuredOutputSchema(AGENT_EXPERIMENT_OUTPUT_SCHEMA),serialized=JSON.stringify(AGENT_EXPERIMENT_OUTPUT_SCHEMA);
    expect(AGENT_EXPERIMENT_OUTPUT_SCHEMA_VERSION).toBe('scanner-agent-experiment-output/1.2.0');
    expect(AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256).toBe('91dad487d0467719215bbb1c86ea950dc6d289f4c64e0e33f6fef97cd8ebf2c7');
    expect(report.validForConfiguredSubset).toBe(true);expect(report.violations).toEqual([]);
    expect(serialized).not.toMatch(/"type":\[[^\]]|"prefixItems"|"const"|"minLength"|"minimum"|"minItems"|"uniqueItems"/u);
  });
  it('preserves strict COMPLETED semantics through normalization and the existing parser',()=>{
    expect(validate(completed)).toBe(true);validateAgentExperimentOutputBranch(completed);
    expect(new AgentOutputValidatorService().parseForRequestId(normalizeAgentExperimentApiOutput(completed),'request-1')).toMatchObject({status:'COMPLETED'});
    const missing={...completed} as Record<string,unknown>;delete missing.requests;expect(validate(missing)).toBe(false);
    expect(()=>validateAgentExperimentOutputBranch({...completed,requests:[]})).toThrow('COMPLETED_REQUESTS_MUST_BE_NULL');
  });
  it('preserves strict NEEDS_ADDITIONAL_CODE semantics and tuple/value constraints in the existing parser',()=>{
    expect(validate(needs)).toBe(true);validateAgentExperimentOutputBranch(needs);
    const parser=new AgentOutputValidatorService();expect(parser.parseForRequestId(normalizeAgentExperimentApiOutput(needs),'request-1')).toMatchObject({status:'NEEDS_ADDITIONAL_CODE'});
    expect(()=>parser.parseForRequestId(normalizeAgentExperimentApiOutput({...needs,requests:[{...needs.requests[0]!,target:{...needs.requests[0]!.target,lines:[1,2,3]}}]}),'request-1')).toThrow();
    expect(()=>parser.parseForRequestId(normalizeAgentExperimentApiOutput({...needs,requests:[{...needs.requests[0]!,maxLines:0}]}),'request-1')).toThrow();
    expect(()=>validateAgentExperimentOutputBranch({...needs,requests:null})).toThrow('CODE_REQUESTS_REQUIRED');
    expect(()=>validateAgentExperimentOutputBranch({...needs,assessments:[]})).toThrow('CODE_REQUEST_EXCLUSIVE_FIELD');
  });
  it('retains uniqueness and numeric bounds in the existing parser after API keyword projection',()=>{
    const assessment={id:'a',type:'CORRELATED_BEHAVIOR',signal:'s',category:'c',basis:'PATTERN_MATCH',findingIds:['x','x'],refs:[{id:'ref',sliceId:'slice',lines:[1,1],role:'SOURCE'}],flow:{},reachability:{status:'UNKNOWN'},verification:{status:'UNVERIFIED',method:'NONE'},confidence:2,reasonCodes:['r']};
    expect(()=>new AgentOutputValidatorService().parseForRequestId(normalizeAgentExperimentApiOutput({...completed,assessments:[assessment]}),'request-1')).toThrow();
  });
});
