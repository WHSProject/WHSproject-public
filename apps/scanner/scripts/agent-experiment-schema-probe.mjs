import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentExperimentOpenAiProvider } from '../dist/application/agent-experiment/agent-experiment-openai.provider.js';
import { AgentExperimentSchemaProbeService } from '../dist/application/agent-experiment/agent-experiment-schema-probe.service.js';
import { redact } from '../dist/application/agent-experiment/agent-experiment.service.js';
import { loadLlmAgentEnvironment } from '../dist/config/scanner-environment.js';

export async function main(argv=process.argv.slice(2),environment=process.env,providerFactory) {
  let args={output:'-',live:false};let output;
  try{
    args=parseArgs(argv);
    let provider,credential;
    if(args.live){credential=environment.OPENAI_API_KEY;if(credential?.trim()){
      const config=loadLlmAgentEnvironment({...environment,LLM_AGENT_ENABLED:'true',LLM_AGENT_TRIGGER_MODE:'ALWAYS',LLM_AGENT_MODEL:args.model,LLM_AGENT_MAX_RETRIES:'0'});
      provider=providerFactory?providerFactory(config):new AgentExperimentOpenAiProvider(config,'medium');
    }}
    output=await new AgentExperimentSchemaProbeService(provider).execute({probeId:args.probeId,model:args.model,reasoningEffort:'medium',live:args.live,maxCalls:1,retry:0,toolsEnabled:false},credential);
  }catch(error){output={contractVersion:'scanner-agent-experiment-schema-probe/1.0.0',executionMode:args.live?'LIVE':'DRY_RUN',status:'FAILED',actualCalls:0,
    failure:{stage:'PREFLIGHT_FAILED',type:'CLI_INPUT_FAILED',code:'CLI_INPUT_FAILED',param:null,message:redact(error instanceof Error?error.message:String(error)),fingerprint:null}};process.exitCode=1;}
  const serialized=`${JSON.stringify(output,null,2)}\n`;if(args.output==='-')process.stdout.write(serialized);else await atomicWrite(resolve(args.output),serialized);return output;
}

export function parseArgs(argv){const out={probeId:undefined,model:undefined,reasoningEffort:'medium',output:'-',live:false},seen=new Set();for(let i=0;i<argv.length;i++){
  const key=argv[i];if(key==='--live'){if(seen.has(key))throw Error('DUPLICATE_OPTION:--live');seen.add(key);out.live=true;continue;}
  if(!['--probe-id','--model','--reasoning-effort','--output'].includes(key))throw Error(`UNKNOWN_OPTION:${key}`);if(seen.has(key))throw Error(`DUPLICATE_OPTION:${key}`);seen.add(key);const value=argv[++i];if(!value)throw Error(`MISSING_OPTION_VALUE:${key}`);
  if(key==='--probe-id')out.probeId=value;else if(key==='--model')out.model=value;else if(key==='--reasoning-effort'){if(value!=='medium')throw Error('PROBE_REASONING_EFFORT_UNSUPPORTED');out.reasoningEffort=value;}else out.output=value;
}if(!out.probeId)throw Error('MISSING_REQUIRED_OPTION:--probe-id');if(!out.model)throw Error('MISSING_REQUIRED_OPTION:--model');return out;}
async function atomicWrite(file,content){await mkdir(dirname(file),{recursive:true});const partial=`${file}.partial`;await writeFile(partial,content,{flag:'wx'});await rename(partial,file);}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
