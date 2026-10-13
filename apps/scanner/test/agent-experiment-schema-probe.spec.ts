import { AgentExperimentOpenAiProvider } from '../src/application/agent-experiment/agent-experiment-openai.provider';
import { AGENT_EXPERIMENT_OUTPUT_SCHEMA, AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256 } from '../src/application/agent-experiment/agent-experiment-output.schema';
import { AGENT_EXPERIMENT_PROBE_REGISTRY, getAgentExperimentProbe } from '../src/application/agent-experiment/agent-experiment-schema-probe.registry';
import { AgentExperimentSchemaProbeService } from '../src/application/agent-experiment/agent-experiment-schema-probe.service';
import { inspectStructuredOutputSchema } from '../src/application/agent-experiment/agent-experiment-structured-output-linter';
import type { AgentProvider } from '../src/llm-agent/openai-provider.client';
import { OpenAiProviderClient } from '../src/llm-agent/openai-provider.client';

const expected=[
  ['P0',null,116,'8dcb8a2e6f4e0186b7303a05bb4adf672f099bf54094e85a6a7f0545bcce01de'],
  ['P1','P0',288,'adae5bfe5bbfd5a1c7f03f0ab52f85b0f7ebaf9bbd1ea70b2ebc2deb06fb3b8d'],
  ['P2','P1',339,'ac257be39c6ba0f4f384f1456c07fdae20e9f9eb1bf00fd327a90e974f08866c'],
  ['P3','P2',784,'07c6c1b61fd9590dfd95fa739a0c76e783a96070b2c557f791eb0edf800e89bc'],
  ['P4','P3',4395,'1a7b49c66878aac0e87c9d72a258411e4ff2c66346f97ce6f470ae5a5ebe685f'],
  ['P5','P4',5315,'32e62e4f7d720dc7cdc12641a7db25c7633340d7c3639d21faa4cd93dde08097'],
  ['P6','P5',5763,'91dad487d0467719215bbb1c86ea950dc6d289f4c64e0e33f6fef97cd8ebf2c7'],
] as const;
const options=(probeId:string,live=false)=>({probeId,model:'gpt-5.6-luna',reasoningEffort:'medium' as const,live,maxCalls:1 as const,retry:0 as const,toolsEnabled:false as const});

describe('schema probe registry',()=>{
  it('contains exactly the pinned P0-P6 parent chain and no duplicate IDs',()=>{expect([...AGENT_EXPERIMENT_PROBE_REGISTRY]).toHaveLength(7);expect([...AGENT_EXPERIMENT_PROBE_REGISTRY.keys()]).toEqual(expected.map(x=>x[0]));for(const [id,parent,bytes,hash]of expected)expect(getAgentExperimentProbe(id)).toMatchObject({probeId:id,parentProbeId:parent,schemaBytes:bytes,schemaSha256:hash});});
  it('uses the exact v1.2 schema object for P6 and all probes lint cleanly',()=>{expect(getAgentExperimentProbe('P6').schema).toBe(AGENT_EXPERIMENT_OUTPUT_SCHEMA);expect(getAgentExperimentProbe('P6').schemaSha256).toBe(AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256);for(const probe of AGENT_EXPERIMENT_PROBE_REGISTRY.values())expect(inspectStructuredOutputSchema(probe.schema).violations).toEqual([]);});
  it('rejects arbitrary probe IDs',()=>expect(()=>getAgentExperimentProbe('P7')).toThrow('UNKNOWN_PROBE_ID'));
  it('validates a minimal synthetic response for every registered probe',()=>{const values=[{requestId:'probe-request'},{requestId:'probe-request',status:'COMPLETED'},{requestId:'probe-request',schemaVersion:'0.1.0',status:'COMPLETED'},
    {requestId:'probe-request',schemaVersion:'0.1.0',status:'COMPLETED',summary:{verdict:'INCONCLUSIVE',confidence:0,reasonCodes:['NO_ASSESSMENTS']}},
    {requestId:'probe-request',schemaVersion:'0.1.0',status:'COMPLETED',summary:{verdict:'INCONCLUSIVE',confidence:0,reasonCodes:['NO_ASSESSMENTS']},assessments:[]},
    {requestId:'probe-request',schemaVersion:'0.1.0',status:'COMPLETED',summary:{verdict:'INCONCLUSIVE',confidence:0,reasonCodes:['NO_ASSESSMENTS']},assessments:[],requests:null},
    {requestId:'probe-request',schemaVersion:'0.1.0',status:'COMPLETED',requests:null,assessments:[],summary:{verdict:'INCONCLUSIVE',confidence:0,reasonCodes:['NO_ASSESSMENTS']},limitations:[],missingContext:[]}];
    expected.forEach(([id],index)=>expect(getAgentExperimentProbe(id).validate(values[index])).toEqual({valid:true,errors:[]}));});
});

describe('schema probe service and provider boundary',()=>{
  it.each(expected.map(x=>x[0]))('dry-runs %s without a provider call',async(probeId)=>{const generate=jest.fn();const result=await new AgentExperimentSchemaProbeService({generate} as AgentProvider).execute(options(probeId));expect(result).toMatchObject({executionMode:'DRY_RUN',actualCalls:0,probe:{probeId},strict:true,retry:0,toolsEnabled:false,maxCalls:1});expect(generate).not.toHaveBeenCalled();});
  it('passes only the selected canonical schema and calls at most once',async()=>{const probe=getAgentExperimentProbe('P0'),generate=jest.fn().mockResolvedValue({text:'{"requestId":"probe-request"}',model:'gpt-5.6-luna',providerRequestId:'res',durationMs:1,usage:{totalTokens:2}});const result=await new AgentExperimentSchemaProbeService({generate} as AgentProvider).execute(options('P0',true));expect(generate).toHaveBeenCalledTimes(1);expect(generate.mock.calls[0]![2]).toBe(probe.schema);expect(result).toMatchObject({actualCalls:1,httpSuccess:true,rawJsonParse:true,probeSchemaValidation:true});});
  it('sends strict boolean, medium reasoning, no tools and a non-stringified selected schema',async()=>{const fetcher=jest.fn().mockResolvedValue({ok:true,json:async()=>({id:'res',model:'gpt-5.6-luna',output:[{content:[{type:'output_text',text:'{"requestId":"probe-request"}'}]}],usage:{}})}),config={OPENAI_API_KEY:'synthetic',LLM_AGENT_MODEL:'gpt-5.6-luna',OPENAI_BASE_URL:'https://api.openai.com'} as never,provider=new AgentExperimentOpenAiProvider(config,'medium',fetcher as unknown as typeof fetch),probe=getAgentExperimentProbe('P0');await provider.generate(probe.instruction,new AbortController().signal,probe.schema);const body=JSON.parse(fetcher.mock.calls[0]![1]!.body as string);expect(body).toMatchObject({reasoning:{effort:'medium'},text:{format:{type:'json_schema',strict:true,schema:probe.schema}}});expect(body).not.toHaveProperty('tools');expect(typeof body.text.format.schema).toBe('object');});
  it('classifies malformed JSON and schema-invalid output',async()=>{const malformed=await new AgentExperimentSchemaProbeService({generate:jest.fn().mockResolvedValue({text:'{',model:'m',usage:{}})} as AgentProvider).execute(options('P0',true));expect(malformed).toMatchObject({failure:{stage:'INVALID_RESPONSE_JSON'},actualCalls:1});const invalid=await new AgentExperimentSchemaProbeService({generate:jest.fn().mockResolvedValue({text:'{}',model:'m',usage:{}})} as AgentProvider).execute(options('P0',true));expect(invalid).toMatchObject({failure:{stage:'PROBE_SCHEMA_VALIDATION_FAILED'},actualCalls:1});});
  it('bounds and redacts generic provider failures',async()=>{const failure=await new AgentExperimentSchemaProbeService({generate:jest.fn().mockRejectedValue(new Error(`Bearer synthetic-secret /Users/person/file ${'x'.repeat(20000)}`))} as AgentProvider).execute(options('P0',true),'synthetic-secret');const serialized=JSON.stringify(failure);expect(failure).toMatchObject({actualCalls:1,failure:{stage:'PROVIDER_REQUEST_FAILED'}});expect(serialized).not.toMatch(/synthetic-secret|\/Users\/person/u);expect((failure.failure as {message:string}).message.length).toBeLessThanOrEqual(16384);});
  it('keeps the production provider request body unchanged',async()=>{const fetcher=jest.fn().mockResolvedValue({ok:true,json:async()=>({id:'r',model:'m',output:[{content:[{type:'output_text',text:'{}'}]}],usage:{}})}),config={OPENAI_API_KEY:'synthetic',LLM_AGENT_MODEL:'m',OPENAI_BASE_URL:'https://api.openai.com'} as never;await new OpenAiProviderClient(config,fetcher as unknown as typeof fetch).generate('prompt',new AbortController().signal);const body=JSON.parse(fetcher.mock.calls[0]![1]!.body as string);expect(body).not.toHaveProperty('reasoning');expect(body.text.format.strict).toBe(false);});
});
