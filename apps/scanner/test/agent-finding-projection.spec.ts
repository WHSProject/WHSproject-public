import type { AnalyzerResult, Finding } from '../src/domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../src/evidence/normalizer/evidence-normalizer.types';
import {
  canonicalJson, projectAgentFindingsV0_3, validateAtomicEvidenceCompatibilityV0_3,
} from '../src/application/agent-input/agent-finding-projection';

const HASH = 'a'.repeat(64);
const finding = (findingId:string, type:string, data:Record<string,unknown>, path?:string):Finding => ({
  findingId, ruleId:`rule.${findingId}`, type, message:`message ${findingId}`,
  ...(path?{location:{type:'SOURCE_FILE' as const,path,startLine:1,endLine:2}}:{}), data,
});
const result = (analyzer:string, analyzerVersion:string, findings:Finding[]):AnalyzerResult => ({
  requestId:'request',scanId:'scan',analyzer,analyzerVersion,status:'SUCCESS',findings,errors:[],
});

describe('Agent Finding v0.3 projection',()=>{
  const inputs=[
    result('metadata','0.1.0',[finding('m','LIFECYCLE_SCRIPT',{z:1,a:'kept'})]),
    result('guarddog','3.1.0',[finding('g','THREAT_INDICATOR',{rule:'x'},'index.js')]),
    result('custom-rule','0.2.0',[finding('c','CAPABILITY_PATTERN',{locations:[{path:'lib.js'}]},'lib.js')]),
  ];
  it('preserves all three analyzer meanings and orders deterministically',()=>{
    const a=projectAgentFindingsV0_3(inputs,HASH,HASH),b=projectAgentFindingsV0_3([...inputs].reverse(),HASH,HASH);
    expect(a.failures).toEqual([]); expect(canonicalJson(a.findings)).toBe(canonicalJson(b.findings));
    expect(a.findings.map(x=>x.analyzer)).toEqual(['custom-rule','guarddog','metadata']);
    expect(a.findings.find(x=>x.findingId==='m')).toMatchObject({analyzerVersion:'0.1.0',type:'LIFECYCLE_SCRIPT',message:'message m',data:{a:'kept',z:1}});
    expect(a.provenance.projectionHash).toBe(b.provenance.projectionHash);
  });
  it('rejects duplicate IDs, missing/unknown analyzer context, and missing versions',()=>{
    expect(projectAgentFindingsV0_3([result('guarddog','3.1.0',[finding('x','T',{}),finding('x','T',{})])],HASH,HASH).failures).toContainEqual(expect.objectContaining({code:'FINDING_ID_DUPLICATE'}));
    expect(projectAgentFindingsV0_3([result('','1',[finding('x','T',{})])],HASH,HASH).failures[0]?.code).toBe('ANALYZER_CONTEXT_MISSING');
    expect(projectAgentFindingsV0_3([result('other','1',[finding('x','T',{})])],HASH,HASH).failures[0]?.code).toBe('ANALYZER_UNSUPPORTED');
    expect(projectAgentFindingsV0_3([result('metadata','',[finding('x','T',{})])],HASH,HASH).failures[0]?.code).toBe('ANALYZER_VERSION_MISSING');
  });
  it('rejects malformed, circular, binary, oversized, and leaking data',()=>{
    const circular:Record<string,unknown>={};circular.self=circular;
    const cases=[circular,{buffer:Buffer.from('x')},{payload:'x'.repeat(70_000)},{path:'/analysis/package/x.js'},{path:'/Users/person/secret'}];
    const codes=cases.map((data,i)=>projectAgentFindingsV0_3([result('guarddog','1',[finding(`f${i}`,'T',data)])],HASH,HASH).failures[0]?.code);
    expect(codes).toEqual(['FINDING_DATA_INVALID','FINDING_DATA_INVALID','FINDING_DATA_TOO_LARGE','PATH_LEAK_DETECTED','PATH_LEAK_DETECTED']);
  });
  it('accepts canonical Atomic Evidence and rejects dangling, foreign, and provenance-mismatched sources',()=>{
    const projected=projectAgentFindingsV0_3(inputs,HASH,HASH).findings;
    const source=projected.find(x=>x.findingId==='g')!;
    const evidence:AtomicEvidenceV0_1={schemaVersion:'0.1',evidenceId:'e1',kind:'ATOMIC',signal:{id:'s',type:'X',category:'CODE'},
      subject:{ecosystem:'npm',packageName:'p',packageVersion:'1',artifactHash:HASH},assertion:{summary:'s',basis:'PATTERN_MATCH'},
      sources:[{analyzer:source.analyzer,analyzerVersion:source.analyzerVersion,ruleId:source.ruleId,rawFindingId:source.findingId}],locations:[],
      provenance:{scanId:'scan',generatedBy:'EVIDENCE_NORMALIZER',observedAt:new Date(0).toISOString()},limitations:[]};
    expect(()=>validateAtomicEvidenceCompatibilityV0_3([evidence],projected,HASH)).not.toThrow();
    expect(()=>validateAtomicEvidenceCompatibilityV0_3([{...evidence,evidenceId:'e2',sources:[{...evidence.sources[0]!,rawFindingId:'missing'}]}],projected,HASH)).toThrow('DANGLING');
    expect(()=>validateAtomicEvidenceCompatibilityV0_3([{...evidence,evidenceId:'e3',subject:{...evidence.subject,artifactHash:'b'.repeat(64)}}],projected,HASH)).toThrow('FOREIGN');
    expect(()=>validateAtomicEvidenceCompatibilityV0_3([{...evidence,evidenceId:'e4',sources:[{...evidence.sources[0]!,analyzer:'metadata'}]}],projected,HASH)).toThrow('PROVENANCE');
  });
});
