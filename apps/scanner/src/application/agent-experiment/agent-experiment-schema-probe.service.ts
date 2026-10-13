import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { AgentProvider } from '../../llm-agent/openai-provider.client';
import { AgentExperimentProviderHttpError } from './agent-experiment-openai.provider';
import { canonicalJson } from './agent-experiment-request.validator';
import { getAgentExperimentProbe } from './agent-experiment-schema-probe.registry';
import { inspectStructuredOutputSchema } from './agent-experiment-structured-output-linter';
import { redact } from './agent-experiment.service';

export interface AgentExperimentSchemaProbeOptions { probeId:string;model:string;reasoningEffort:'medium';live:boolean;maxCalls:1;retry:0;toolsEnabled:false }

export class AgentExperimentSchemaProbeService {
  constructor(private readonly provider?:AgentProvider){}
  async execute(options:AgentExperimentSchemaProbeOptions,credential?:string):Promise<Record<string,unknown>> {
    const probe=getAgentExperimentProbe(options.probeId);if(!options.model.trim())throw new Error('PROBE_MODEL_REQUIRED');
    if(options.reasoningEffort!=='medium')throw new Error('PROBE_REASONING_EFFORT_UNSUPPORTED');if(options.maxCalls!==1||options.retry!==0||options.toolsEnabled)throw new Error('PROBE_EXECUTION_POLICY_INVALID');
    if(probe.schemaSha256!==sha(JSON.stringify(probe.schema))||!inspectStructuredOutputSchema(probe.schema).validForConfiguredSubset)throw new Error('PROBE_SCHEMA_PREFLIGHT_FAILED');
    const base={contractVersion:'scanner-agent-experiment-schema-probe/1.0.0',executionMode:options.live?'LIVE':'DRY_RUN',probe:{probeId:probe.probeId,parentProbeId:probe.parentProbeId,purpose:probe.purpose,
      schemaVersion:probe.schemaVersion,schemaBytes:probe.schemaBytes,schemaSha256:probe.schemaSha256,instructionSha256:probe.instructionSha256},requestedModel:options.model,
      reasoning:{requestedEffort:'medium',configurationSource:'AGENT_EXPERIMENT_EXPLICIT'},strict:true,retry:0,toolsEnabled:false,maxCalls:1,
      canonicalRequestShapeSha256:sha(canonicalJson({model:options.model,inputSha256:probe.instructionSha256,reasoning:{effort:'medium'},store:false,text:{format:{type:'json_schema',name:'scanner_agent_schema_probe',schemaSha256:probe.schemaSha256,strict:true}}}))};
    if(!options.live)return{...base,returnedModel:null,providerRequestId:null,responseId:null,httpSuccess:null,usage:null,providerDurationMs:null,totalDurationMs:null,rawOutputSha256:null,rawJsonParse:null,probeSchemaValidation:null,failure:null,actualCalls:0};
    if(!this.provider)return{...base,returnedModel:null,providerRequestId:null,responseId:null,httpSuccess:false,usage:null,providerDurationMs:null,totalDurationMs:null,rawOutputSha256:null,rawJsonParse:null,probeSchemaValidation:null,failure:{stage:'PREFLIGHT_FAILED',type:'PROVIDER_UNAVAILABLE',code:'PROVIDER_UNAVAILABLE',param:null,message:'Live provider is not configured',fingerprint:sha('PREFLIGHT_FAILED\0PROVIDER_UNAVAILABLE')},actualCalls:0};
    const started=performance.now();
    try{const response=await this.provider.generate(probe.instruction,new AbortController().signal,probe.schema);let parsed:unknown;
      try{parsed=JSON.parse(response.text)}catch{return{...base,returnedModel:response.model,providerRequestId:response.providerRequestId??null,responseId:response.providerRequestId??null,httpSuccess:true,usage:response.usage,providerDurationMs:response.durationMs,totalDurationMs:performance.now()-started,rawOutputSha256:sha(response.text),rawJsonParse:false,probeSchemaValidation:null,failure:{stage:'INVALID_RESPONSE_JSON',type:'INVALID_RESPONSE_JSON',code:'INVALID_RESPONSE_JSON',param:null,message:'Provider output was not valid JSON',fingerprint:sha('INVALID_RESPONSE_JSON')},actualCalls:1}}
      const validation=probe.validate(parsed);return{...base,returnedModel:response.model,providerRequestId:response.providerRequestId??null,responseId:response.providerRequestId??null,httpSuccess:true,usage:response.usage,providerDurationMs:response.durationMs,totalDurationMs:performance.now()-started,rawOutputSha256:sha(response.text),rawJsonParse:true,probeSchemaValidation:validation.valid,failure:validation.valid?null:{stage:'PROBE_SCHEMA_VALIDATION_FAILED',type:'SCHEMA_VALIDATION',code:'PROBE_SCHEMA_VALIDATION_FAILED',param:null,message:validation.errors.join('; ').slice(0,16384),fingerprint:sha(validation.errors.join('\0'))},actualCalls:1};
    }catch(error){const details=error instanceof AgentExperimentProviderHttpError?error.details:null;return{...base,returnedModel:null,providerRequestId:details?.requestId??null,responseId:null,httpSuccess:false,usage:null,providerDurationMs:null,totalDurationMs:performance.now()-started,rawOutputSha256:null,rawJsonParse:null,probeSchemaValidation:null,failure:{stage:'PROVIDER_REQUEST_FAILED',type:details?.error.type??'PROVIDER_ERROR',code:details?.error.code??'PROVIDER_ERROR',param:details?.error.param??null,message:redact(details?.error.message??(error instanceof Error?error.message:String(error)),credential).slice(0,16384),fingerprint:details?.errorFingerprint??sha('PROVIDER_ERROR')},actualCalls:1};}
  }
}
function sha(value:string):string{return createHash('sha256').update(value).digest('hex');}
