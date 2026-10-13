import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AgentExperimentService } from '../src/application/agent-experiment/agent-experiment.service';
import { AgentExperimentOpenAiProvider, AgentExperimentProviderHttpError, extractProviderError } from '../src/application/agent-experiment/agent-experiment-openai.provider';
import { AGENT_EXPERIMENT_OUTPUT_SCHEMA, AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256, normalizeAgentExperimentApiOutput,
  validateAgentExperimentApiOutput, validateAgentExperimentOutputBranch } from '../src/application/agent-experiment/agent-experiment-output.schema';
import { renderAgentExperimentPrompt } from '../src/application/agent-experiment/agent-experiment-prompt.renderer';
import { AgentExperimentRequestValidationError, AgentExperimentRequestValidator, canonicalJson } from '../src/application/agent-experiment/agent-experiment-request.validator';
import type { AgentExperimentInputProfile, AgentExperimentRequestV0_3 } from '../src/application/agent-experiment/agent-experiment.types';
import { OpenAiProviderClient, type AgentProvider } from '../src/llm-agent/openai-provider.client';
import { AgentOutputValidatorService } from '../src/llm-agent/agent-output-validator.service';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const Ajv2020 = createRequire(__filename)('ajv/dist/2020').default as new (options?: Record<string, unknown>) => { addSchema(schema: object): void; compile(schema: object): (value: unknown) => boolean };
const content = 'const value = process.env.HOME;';
const finding = { findingId: 'finding-1', analyzer: 'guarddog' as const, analyzerVersion: '3.1.0', ruleId: 'env-read', type: 'CAPABILITY',
  message: 'Environment access', location: { type: 'SOURCE_FILE' as const, path: 'index.js', startLine: 1 }, data: { z: 1, nested: { b: 2, a: 1 } } };
const evidence = { schemaVersion: '0.1' as const, evidenceId: 'evidence-1', kind: 'ATOMIC' as const,
  signal: { id: 'ENV_READ', type: 'ENV_READ', category: 'ENVIRONMENT' }, subject: { ecosystem: 'npm' as const, packageName: 'pkg', packageVersion: '1.0.0', artifactHash: 'a'.repeat(64) },
  assertion: { summary: 'Reads environment', basis: 'PATTERN_MATCH' as const }, sources: [{ analyzer: 'guarddog', analyzerVersion: '3.1.0', ruleId: 'env-read', rawFindingId: 'finding-1' }],
  locations: [{ type: 'SOURCE_FILE' as const, path: 'index.js', startLine: 1 }], provenance: { scanId: 'scan', generatedBy: 'EVIDENCE_NORMALIZER' as const, observedAt: '1970-01-01T00:00:00.000Z' }, limitations: [] };

function fixture(profile: AgentExperimentInputProfile): AgentExperimentRequestV0_3 {
  return { request: { analysisRequestId: 'request-1', requestType: 'MALICIOUS_CODE_ANALYSIS', inputProfile: profile, schemaVersion: '0.3.0', sampleId: 'SAMPLE-001', createdAt: null },
    subject: { ecosystem: 'npm', packageName: 'pkg', packageVersion: '1.0.0', archiveSha256: 'a'.repeat(64) },
    packageContext: { source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION', description: 'fixture', main: 'index.js', exports: null, scripts: {}, dependencies: {},
      entryPoints: [{ type: 'MAIN', value: 'index.js', location: { file: 'package.json', startLine: 1, endLine: null } }], lifecycleScripts: [] },
    findings: profile === 'CODE_ONLY' ? [] : [structuredClone(finding)], atomicEvidences: profile === 'CODE_FINDING_EVIDENCE' ? [structuredClone(evidence)] : [],
    analysisPolicy: {}, initialCodeSlices: [{ sliceId: 'slice-1', file: 'index.js', startLine: 1, endLine: 1, content, contentSha256: sha(content), sourceSha256: sha(content),
      contentRedacted: false, redactionTypes: [], boundaryConfidence: 'HIGH', selectionReason: 'FIXTURE', relatedFindingIds: [] }],
    analysisTargets: [], toolResponseCatalog: [], missingData: [] };
}

const completed = JSON.stringify({ requestId: 'request-1', schemaVersion: '0.1.0', status: 'COMPLETED', requests: null, assessments: [],
  summary: { verdict: 'INCONCLUSIVE', confidence: 0, reasonCodes: ['NO_ASSESSMENTS'] }, limitations: [], missingContext: [] });

describe('Agent experiment request 0.3 contract', () => {
  const validator = new AgentExperimentRequestValidator();
  it.each(['CODE_ONLY', 'CODE_FINDING', 'CODE_FINDING_EVIDENCE'] as const)('accepts %s', (profile) => expect(validator.validate(fixture(profile)).request.inputProfile).toBe(profile));
  it('preserves all three analyzers and type/message/location/data', () => {
    const input = fixture('CODE_FINDING');
    input.findings = ['guarddog', 'metadata', 'custom-rule'].map((analyzer, index) => ({ ...structuredClone(finding), findingId: `f-${index}`, analyzer: analyzer as typeof finding.analyzer,
      analyzerVersion: String(index + 1), ruleId: `r-${index}`, type: `TYPE-${index}`, message: `message-${index}`, data: { index, nested: { value: analyzer } } }));
    input.initialCodeSlices[0]!.relatedFindingIds = input.findings.map(({ findingId }) => findingId);
    const validated = validator.validate(input);
    expect(validated.findings).toEqual(expect.arrayContaining(input.findings));
    expect(validated.findings.map(({ analyzer }) => analyzer).sort()).toEqual(['custom-rule', 'guarddog', 'metadata']);
  });
  it('allows only canonical sourceType paths and preserves their values', () => {
    const input=fixture('CODE_FINDING_EVIDENCE');
    input.findings[0]!.data.sourceType={ semantic:'ENVIRONMENT_VARIABLE' };
    input.atomicEvidences[0]!.sourceType='CANONICAL_EVIDENCE_SOURCE';
    const validated=validator.validate(input);
    expect(validated.findings[0]!.data.sourceType).toEqual({semantic:'ENVIRONMENT_VARIABLE'});
    expect(validated.atomicEvidences[0]!.sourceType).toBe('CANONICAL_EVIDENCE_SOURCE');
  });
  it.each([
    ['top-level', (input: AgentExperimentRequestV0_3) => { (input as unknown as Record<string,unknown>).sourceType='COMPROMISED'; }],
    ['fixture', (input: AgentExperimentRequestV0_3) => { (input as unknown as Record<string,unknown>).fixture={sourceType:'COMPROMISED'}; }],
    ['dataset', (input: AgentExperimentRequestV0_3) => { (input as unknown as Record<string,unknown>).dataset={sourceType:'COMPROMISED'}; }],
    ['unexpected finding data nesting', (input: AgentExperimentRequestV0_3) => { input.findings[0]!.data.nested={sourceType:'COMPROMISED'}; }],
  ])('rejects management sourceType at %s', (_name,mutate) => { const input=fixture('CODE_FINDING_EVIDENCE');mutate(input);expect(()=>validator.validate(input)).toThrow(/SCHEMA|MANAGEMENT_FIELD_FORBIDDEN/u); });
  it.each(['split','leakageGroupId','groundTruth','expectedLabel','reviewerDecision','quickDecision','finalDecision'])(
    'continues to reject management field %s', (key) => { const input=fixture('CODE_FINDING_EVIDENCE');input.findings[0]!.data[key]='forbidden';expect(()=>validator.validate(input)).toThrow('MANAGEMENT_FIELD_FORBIDDEN'); });
  it.each([
    ['duplicate finding', (input: AgentExperimentRequestV0_3) => input.findings.push(structuredClone(input.findings[0]!)), 'DUPLICATE_FINDING_ID'],
    ['dangling evidence', (input: AgentExperimentRequestV0_3) => { input.atomicEvidences[0]!.sources[0]!.rawFindingId='missing'; }, 'DANGLING_EVIDENCE_FINDING'],
    ['unknown analyzer', (input: AgentExperimentRequestV0_3) => { (input.findings[0] as { analyzer:string }).analyzer='other'; }, 'SCHEMA'],
    ['host path', (input: AgentExperimentRequestV0_3) => { input.findings[0]!.location!.path='/Users/person/secret.js'; }, 'UNSAFE_PATH'],
    ['container path', (input: AgentExperimentRequestV0_3) => { input.findings[0]!.location!.path='/analysis/package/index.js'; }, 'UNSAFE_PATH'],
    ['management field', (input: AgentExperimentRequestV0_3) => { (input as unknown as Record<string, unknown>).split='DEVELOPMENT'; }, 'SCHEMA'],
  ])('rejects %s', (_name, mutate, issue) => { const input=fixture('CODE_FINDING_EVIDENCE'); mutate(input); expect(() => validator.validate(input)).toThrow(issue); });
  it('rejects malformed, circular and non-finite data', () => {
    const circular=fixture('CODE_FINDING'); (circular.findings[0]!.data as Record<string, unknown>).self=circular.findings[0]!.data;
    expect(() => validator.validate(circular)).toThrow('CIRCULAR_VALUE');
    const nonFinite=fixture('CODE_FINDING'); nonFinite.findings[0]!.data.value=Number.NaN;
    expect(() => validator.validate(nonFinite)).toThrow('NON_FINITE_NUMBER');
  });
  it('pins the Scanner-owned request schema hash', () => {
    expect(sha(readFileSync(resolve(__dirname, '../src/contracts/agent-analysis/agent-analysis-request.v0.3.schema.json'), 'utf8')))
      .toBe('34ca78e142ee01d13b9eada99c159cac400d57a0d216926dff543bef6ff3910e');
  });
  it('compiles the request schema using only Scanner-owned contracts', () => {
    const root=resolve(__dirname,'../src/contracts/agent-analysis');
    const base=JSON.parse(readFileSync(resolve(root,'agent-analysis-request.schema.json'),'utf8')) as object;
    const request=JSON.parse(readFileSync(resolve(root,'agent-analysis-request.v0.3.schema.json'),'utf8')) as object;
    const ajv=new Ajv2020({allErrors:true,strict:false,formats:{'date-time':/^\d{4}-/u}}); ajv.addSchema(base);
    expect(ajv.compile(request)(fixture('CODE_FINDING_EVIDENCE'))).toBe(true);
    expect(sha(readFileSync(resolve(root,'agent-analysis-request.schema.json'),'utf8'))).toBe('2b310cde55e0d92b26764919baec2033d9b11849334c372364192a6fa3825ff2');
  });
});

describe('Agent experiment prompt renderer', () => {
  it('states every branch-exclusive null rule and keeps requests as the only missing-code channel', () => {
    const prompt=renderAgentExperimentPrompt(fixture('CODE_ONLY')).prompt;
    for(const rule of ['requests must be null','assessments, summary, limitations, and missingContext must all be null',
      'limitations and missingContext belong only to COMPLETED','describe the required code scope only in requests']) expect(prompt).toContain(rule);
  });
  it('renders disclosure profiles without changing common slices or A2/A3 findings', () => {
    const a1=fixture('CODE_ONLY'), a2=fixture('CODE_FINDING'), a3=fixture('CODE_FINDING_EVIDENCE');
    const rendered=[a1,a2,a3].map(renderAgentExperimentPrompt);
    expect(rendered[0]!.prompt).not.toContain('finding-1');
    expect(rendered[1]!.prompt).toContain('finding-1'); expect(rendered[1]!.prompt).not.toContain('evidence-1');
    expect(rendered[2]!.prompt).toContain('finding-1'); expect(rendered[2]!.prompt).toContain('evidence-1');
    expect(canonicalJson(a2.findings)).toBe(canonicalJson(a3.findings));
    expect(canonicalJson(a1.initialCodeSlices)).toBe(canonicalJson(a2.initialCodeSlices));
    expect(renderAgentExperimentPrompt(a3)).toEqual(renderAgentExperimentPrompt(structuredClone(a3)));
    for (const prompt of rendered.map(({ prompt }) => prompt)) expect(prompt).not.toMatch(/groundTruth|expectedVerdict|humanReviewer|DEVELOPMENT/u);
  });
  it('renders analyzer/version/type/message/location/data losslessly and canonicalizes data keys', () => {
    const input=fixture('CODE_FINDING'); const prompt=renderAgentExperimentPrompt(input).prompt;
    for (const value of ['guarddog','3.1.0','CAPABILITY','Environment access','index.js','nested']) expect(prompt).toContain(value);
    expect(prompt.indexOf('"a":1')).toBeLessThan(prompt.indexOf('"b":2'));
  });
});

describe('Agent experiment one-shot service', () => {
  it('is dry-run by default at the service boundary and makes no provider call', async () => {
    const generate=jest.fn(); const result=await new AgentExperimentService(undefined,{generate} as AgentProvider).execute(fixture('CODE_ONLY'),{live:false,timeoutMs:1000,maxRetries:0,model:'model',reasoningEffort:'medium'});
    expect(result).toMatchObject({executionMode:'DRY_RUN',status:'VALIDATED',reasoning:{requestedEffort:'medium',configurationSource:'AGENT_EXPERIMENT_EXPLICIT'},rawModelOutput:null,validatedResult:null}); expect(generate).not.toHaveBeenCalled();
  });
  it('fails closed without a live provider', async () => expect(await new AgentExperimentService().execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'model',reasoningEffort:'medium'})).toMatchObject({status:'FAILED',error:{code:'CREDENTIAL_OR_PROVIDER_UNAVAILABLE'}}));
  it('performs exactly one live call and returns usage, response ID, latency, raw and validated output', async () => {
    const generate=jest.fn().mockResolvedValue({text:completed,model:'returned-model',providerRequestId:'response-1',durationMs:12,usage:{inputTokens:4,outputTokens:5,totalTokens:9}});
    const result=await new AgentExperimentService(undefined,{generate} as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'model',reasoningEffort:'medium'});
    expect(generate).toHaveBeenCalledTimes(1); expect(result).toMatchObject({status:'COMPLETED',responseValidation:'PASS',analysisOutcome:'COMPLETED',toolDisposition:'NOT_APPLICABLE',additionalModelRounds:0,rawModelOutput:completed,provider:{model:'returned-model',responseId:'response-1',durationMs:12,usage:{totalTokens:9}}});
  });
  it('does not issue a second call when the model requests code', async () => {
    const needs=JSON.stringify({requestId:'request-1',schemaVersion:'0.1.0',status:'NEEDS_ADDITIONAL_CODE',requests:[{id:'r',type:'GET_FILE_RANGE',target:{file:'x',symbol:null,lines:[1,1]},reasonCode:'MISSING_CONTEXT',maxLines:1}],assessments:null,summary:null,limitations:null,missingContext:null});
    const generate=jest.fn().mockResolvedValue({text:needs,model:'m',durationMs:1,usage:{}});
    const result=await new AgentExperimentService(undefined,{generate} as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'m',reasoningEffort:'medium'});
    expect(generate).toHaveBeenCalledTimes(1); expect(result).toMatchObject({status:'COMPLETED',responseValidation:'PASS',analysisOutcome:'NEEDS_ADDITIONAL_CODE',
      toolDisposition:'NOT_EXECUTED_BY_EXPERIMENT_POLICY',additionalModelRounds:0,outcomeDetailCode:'ADDITIONAL_CODE_REQUESTED_TOOL_DISABLED',
      validatedResult:{status:'NEEDS_ADDITIONAL_CODE',requests:[{id:'r'}]},validationFailures:[],error:null});
  });
  it('bounds output and times out without retrying', async () => {
    const oversized=jest.fn().mockResolvedValue({text:'x'.repeat(4*1024*1024+1),model:'m',durationMs:1,usage:{}});
    expect(await new AgentExperimentService(undefined,{generate:oversized} as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'m',reasoningEffort:'medium'}))
      .toMatchObject({status:'FAILED',error:{code:'MODEL_OUTPUT_TOO_LARGE'}});
    const pending=jest.fn(()=>new Promise(()=>undefined));
    const result=await new AgentExperimentService(undefined,{generate:pending} as unknown as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:5,maxRetries:0,model:'m',reasoningEffort:'medium'});
    expect(pending).toHaveBeenCalledTimes(1); expect(result).toMatchObject({status:'TIMEOUT',error:{code:'TIMEOUT'}});
  });
  it('rejects retries and redacts credentials and host paths from failures', async () => {
    await expect(new AgentExperimentService().execute(fixture('CODE_ONLY'),{live:false,timeoutMs:1000,maxRetries:1 as 0,model:'',reasoningEffort:'medium'})).rejects.toThrow('RETRY');
    const generate=jest.fn().mockRejectedValue(new Error('Bearer secret-secret-secret /Users/person/file'));
    const result=await new AgentExperimentService(undefined,{generate} as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'m',reasoningEffort:'medium'},'secret-secret-secret');
    expect(JSON.stringify(result)).not.toContain('secret-secret-secret'); expect(JSON.stringify(result)).not.toContain('/Users/person');
  });
  it('adds explicit medium reasoning only in the experiment provider request', async () => {
    const fetcher=jest.fn().mockResolvedValue({ok:true,json:async()=>({id:'r',model:'gpt-5.6-luna',output:[{content:[{type:'output_text',text:completed}]}],usage:{}})});
    const config={OPENAI_API_KEY:'secret',LLM_AGENT_MODEL:'gpt-5.6-luna',OPENAI_BASE_URL:'https://api.openai.com'} as never;
    const provider=new AgentExperimentOpenAiProvider(config,'medium',fetcher as unknown as typeof fetch);
    await provider.generate('prompt',new AbortController().signal);
    const body=JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.reasoning).toEqual({effort:'medium'});expect(body.text.format.strict).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(()=>new AgentExperimentOpenAiProvider(config,'high' as 'medium',fetcher as unknown as typeof fetch)).toThrow('REASONING_EFFORT_UNSUPPORTED');
  });
  it('leaves the production provider request body without a reasoning field', async () => {
    const fetcher=jest.fn().mockResolvedValue({ok:true,json:async()=>({id:'r',model:'gpt-5.6-luna',output:[{content:[{type:'output_text',text:completed}]}],usage:{}})});
    const config={OPENAI_API_KEY:'secret',LLM_AGENT_MODEL:'gpt-5.6-luna',OPENAI_BASE_URL:'https://api.openai.com'} as never;
    await new OpenAiProviderClient(config,fetcher as unknown as typeof fetch).generate('prompt',new AbortController().signal);
    const body=JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).not.toHaveProperty('reasoning');
    expect(body).toMatchObject({model:'gpt-5.6-luna',input:'prompt',store:false,text:{format:{type:'json_schema',name:'scanner_agent_analysis',strict:false}}});
  });
});

describe('Agent experiment API-facing output schema', () => {
  const validate=new Ajv2020({allErrors:true,strict:false}).compile(AGENT_EXPERIMENT_OUTPUT_SCHEMA);
  const completedObject=JSON.parse(completed) as Record<string,unknown>;
  const needsObject={requestId:'request-1',schemaVersion:'0.1.0',status:'NEEDS_ADDITIONAL_CODE',requests:[{id:'r',type:'GET_FILE_RANGE',target:{file:'index.js',symbol:null,lines:[1,2]},reasonCode:'MISSING_CONTEXT',maxLines:2}],assessments:null,summary:null,limitations:null,missingContext:null};
  it('is a deterministic root object without a root union and pins production schema',()=>{
    expect(AGENT_EXPERIMENT_OUTPUT_SCHEMA).toMatchObject({type:'object',additionalProperties:false,required:expect.arrayContaining(['status','requests','assessments','summary','limitations','missingContext'])});
    expect(AGENT_EXPERIMENT_OUTPUT_SCHEMA).not.toHaveProperty('oneOf');expect(AGENT_EXPERIMENT_OUTPUT_SCHEMA).not.toHaveProperty('anyOf');
    expect((AGENT_EXPERIMENT_OUTPUT_SCHEMA.properties as Record<string,{description?:string}>).status?.description).toContain('branch validator');
    expect(sha(readFileSync(resolve(__dirname,'../src/llm-agent/output-schema.ts'),'utf8'))).toBe('0c8159c8b07790f034e6219da1fe00a0d2461af90ccbb5c7b7ae5af4a1226f1b');
  });
  it('projects nested objects into the supported closed-object subset',()=>{
    const visit=(value:unknown,path='$'):void=>{if(Array.isArray(value)){value.forEach((item,index)=>visit(item,`${path}[${index}]`));return;}if(!value||typeof value!=='object')return;const object=value as Record<string,unknown>;
      if(object.type==='object'){expect(object.additionalProperties).toBe(false);const keys=Object.keys((object.properties??{}) as object).sort();expect([...(object.required as string[])].sort()).toEqual(keys);}
      if(typeof object.$ref==='string')expect(object.$ref).toMatch(/^#\//u);for(const[key,item]of Object.entries(object))visit(item,`${path}.${key}`);};
    visit(AGENT_EXPERIMENT_OUTPUT_SCHEMA);expect(JSON.stringify(AGENT_EXPERIMENT_OUTPUT_SCHEMA)).not.toMatch(/"prefixItems"|"if"|"then"|"else"|"not"/u);
  });
  it('validates and normalizes COMPLETED while enforcing branch exclusivity',()=>{
    expect(validate(completedObject)).toBe(true);expect(validateAgentExperimentApiOutput(completedObject)).toEqual([]);validateAgentExperimentOutputBranch(completedObject);const normalized=normalizeAgentExperimentApiOutput(completedObject);
    expect(new AgentOutputValidatorService().parseForRequestId(normalized,'request-1')).toMatchObject({status:'COMPLETED',assessments:[]});
    expect(()=>normalizeAgentExperimentApiOutput({...completedObject,summary:null})).toThrow('COMPLETED_FIELD_NULL');
    expect(()=>normalizeAgentExperimentApiOutput({...completedObject,requests:[]})).toThrow('COMPLETED_REQUESTS_MUST_BE_NULL');
  });
  it('validates and normalizes NEEDS_ADDITIONAL_CODE while preserving request structure',()=>{
    expect(validate(needsObject)).toBe(true);expect(validateAgentExperimentApiOutput(needsObject)).toEqual([]);validateAgentExperimentOutputBranch(needsObject);const parsed=new AgentOutputValidatorService().parseForRequestId(normalizeAgentExperimentApiOutput(needsObject),'request-1');
    expect(parsed).toMatchObject({status:'NEEDS_ADDITIONAL_CODE',requests:[{target:{file:'index.js',lines:[1,2]},reasonCode:'MISSING_CONTEXT'}]});
    expect(()=>normalizeAgentExperimentApiOutput({...needsObject,requests:null})).toThrow('CODE_REQUESTS_REQUIRED');
    for(const [field,value] of [['assessments',[]],['summary',completedObject.summary],['limitations',['wrong branch']],['missingContext',['wrong branch']]] as const)
      expect(()=>normalizeAgentExperimentApiOutput({...needsObject,[field]:value})).toThrow(`CODE_REQUEST_EXCLUSIVE_FIELD:${field}`);
    expect(()=>normalizeAgentExperimentApiOutput({...needsObject,limitations:['mixed'],missingContext:['mixed']})).toThrow('CODE_REQUEST_EXCLUSIVE_FIELD');
  });
  it('passes the experiment schema only through the experiment service provider boundary',async()=>{
    const generate=jest.fn().mockResolvedValue({text:completed,model:'m',durationMs:1,usage:{}});await new AgentExperimentService(undefined,{generate} as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'m',reasoningEffort:'medium'});
    expect(generate.mock.calls[0]![2]).toBe(AGENT_EXPERIMENT_OUTPUT_SCHEMA);
  });
  it('classifies a syntactically valid but nonconforming API-facing response as schema failure',async()=>{
    const legacy=JSON.stringify({requestId:'request-1',schemaVersion:'0.1.0',status:'COMPLETED',assessments:[],summary:{verdict:'INCONCLUSIVE',confidence:0,reasonCodes:['X']},limitations:[],missingContext:[]});
    const result=await new AgentExperimentService(undefined,{generate:jest.fn().mockResolvedValue({text:legacy,model:'m',durationMs:1,usage:{}})} as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'m',reasoningEffort:'medium'});
    expect(result).toMatchObject({status:'FAILED',error:{code:'OUTPUT_SCHEMA_VALIDATION_FAILED'}});
    expect(result.validationFailures.join(' ')).toMatch(/required.*requests/u);
  });
  it('validates the raw schema before branch semantics and normalization',async()=>{
    const missing={...completedObject};delete missing.requests;
    const missingResult=await new AgentExperimentService(undefined,{generate:jest.fn().mockResolvedValue({text:JSON.stringify(missing),model:'m',durationMs:1,usage:{}})} as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'m',reasoningEffort:'medium'});
    expect(missingResult.error?.code).toBe('OUTPUT_SCHEMA_VALIDATION_FAILED');
    const mixed={...completedObject,requests:[]};
    const mixedResult=await new AgentExperimentService(undefined,{generate:jest.fn().mockResolvedValue({text:JSON.stringify(mixed),model:'m',durationMs:1,usage:{}})} as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'m',reasoningEffort:'medium'});
    expect(mixedResult).toMatchObject({responseValidation:'FAIL',analysisOutcome:'UNAVAILABLE',error:{code:'BRANCH_SEMANTIC_VALIDATION_FAILED'}});
    const invalid=await new AgentExperimentService(undefined,{generate:jest.fn().mockResolvedValue({text:'{',model:'m',durationMs:1,usage:{}})} as AgentProvider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'m',reasoningEffort:'medium'});
    expect(invalid.error?.code).toBe('INVALID_RESPONSE_JSON');
  });
});

describe('Agent experiment bounded provider diagnostics', () => {
  const jsonError = (message: string, headers: Record<string,string> = {}) => new Response(JSON.stringify({error:{type:'invalid_request_error',code:'invalid_parameter',param:'text.format.schema',message}}),{status:400,headers:{'content-type':'application/json',...headers}});
  it('extracts the allowlisted JSON error fields and official request ID deterministically', async () => {
    const a=await extractProviderError(jsonError('Invalid schema',{'x-request-id':'req_safe'}));
    const b=await extractProviderError(jsonError('Invalid schema',{'x-request-id':'req_safe'}));
    expect(a).toMatchObject({httpStatus:400,requestId:'req_safe',error:{type:'invalid_request_error',code:'invalid_parameter',param:'text.format.schema',message:'Invalid schema'},bodyTruncated:false});
    expect(a.errorFingerprint).toBe(b.errorFingerprint);
  });
  it('bounds non-JSON bodies and redacts keys, bearer values, credentials and host paths', async () => {
    const credential='synthetic-key-value-not-real';
    const response=new Response(`Bearer synthetic-bearer sk-synthetic12345678 api_key=synthetic-secret ${credential} /Users/person/file /private/tmp/private/file ${'x'.repeat(20*1024)}`,{status:400});
    const result=await extractProviderError(response,credential), serialized=JSON.stringify(result);
    expect(result.bodyTruncated).toBe(true); expect(result.error.message).toBe('Provider returned a non-JSON error response');
    for(const forbidden of ['synthetic-bearer','sk-synthetic12345678','synthetic-secret',credential,'/Users/person','/private/tmp/private']) expect(serialized).not.toContain(forbidden);
  });
  it('surfaces only sanitized provider diagnostics through the experiment service', async () => {
    const fetcher=jest.fn().mockResolvedValue(jsonError('Bearer synthetic-bearer /Users/person/file',{'x-request-id':'req_400'}));
    const config={OPENAI_API_KEY:'synthetic-key-value-not-real',LLM_AGENT_MODEL:'gpt-5.6-luna',OPENAI_BASE_URL:'https://api.openai.com'} as never;
    const provider=new AgentExperimentOpenAiProvider(config,'medium',fetcher as unknown as typeof fetch);
    const result=await new AgentExperimentService(undefined,provider).execute(fixture('CODE_ONLY'),{live:true,timeoutMs:1000,maxRetries:0,model:'gpt-5.6-luna',reasoningEffort:'medium'},'synthetic-key-value-not-real');
    expect(result).toMatchObject({status:'FAILED',error:{code:'PROVIDER_ERROR',provider:{httpStatus:400,requestId:'req_400',error:{type:'invalid_request_error'}}}});
    expect(JSON.stringify(result)).not.toMatch(/synthetic-bearer|\/Users\/person|synthetic-key-value-not-real/u);
  });
  it('throws the experiment-only typed error without changing successful response handling', async () => {
    const config={OPENAI_API_KEY:'synthetic-key-value-not-real',LLM_AGENT_MODEL:'gpt-5.6-luna',OPENAI_BASE_URL:'https://api.openai.com'} as never;
    const bad=new AgentExperimentOpenAiProvider(config,'medium',jest.fn().mockResolvedValue(jsonError('bad')) as unknown as typeof fetch);
    await expect(bad.generate('prompt',new AbortController().signal)).rejects.toBeInstanceOf(AgentExperimentProviderHttpError);
    const good=new AgentExperimentOpenAiProvider(config,'medium',jest.fn().mockResolvedValue(new Response(JSON.stringify({id:'res',model:'gpt-5.6-luna',output:[{content:[{type:'output_text',text:completed}]}],usage:{}}),{status:200,headers:{'content-type':'application/json'}})) as unknown as typeof fetch);
    await expect(good.generate('prompt',new AbortController().signal)).resolves.toMatchObject({text:completed,model:'gpt-5.6-luna',providerRequestId:'res'});
  });
});
