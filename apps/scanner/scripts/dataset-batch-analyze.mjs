import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalStaticAnalysisService } from '../dist/application/local-static-analysis/local-static-analysis.service.js';
import { AtomicSmokeInvocationBudget } from '../dist/application/local-static-analysis/smoke-invocation-budget.js';
import { batchIdentityHash, isReusableSuccess, sealPrimaryManifest } from '../dist/application/dataset-batch/dataset-batch.contract.js';
import { DockerExternalGuardDogRunner, EXTERNAL_GUARDDOG_SANDBOX_POLICY_VERSION } from '../dist/analyzers/guarddog/docker-external-guarddog.runner.js';
import { GuardDogAnalyzer } from '../dist/analyzers/guarddog/guarddog.analyzer.js';
import { DockerExternalCustomRuleRunner, EXTERNAL_CUSTOM_RULE_SANDBOX_POLICY_VERSION } from '../dist/analyzers/custom-rule/docker-external-custom-rule.runner.js';
import { CustomRuleAnalyzer } from '../dist/analyzers/custom-rule/custom-rule.analyzer.js';
import { MetadataAnalyzer } from '../dist/analyzers/metadata/metadata.analyzer.js';
import { PackageIdentityVerifier } from '../dist/artifact/identity/package-identity-verifier.js';
import { ArtifactHasher } from '../dist/artifact/hasher/artifact-hasher.js';
import { EvidenceNormalizer } from '../dist/evidence/normalizer/evidence-normalizer.js';
import { projectAgentFindingsV0_3, validateAtomicEvidenceCompatibilityV0_3 } from '../dist/application/agent-input/agent-finding-projection.js';

const args = parseArgs(process.argv.slice(2));
for (const key of ['manifest','quarantine','features','artifactRoot','archiveRoot','output','image','imageDigest']) if (!args[key]) throw new Error(`MISSING_ARGUMENT:${key}`);
if (args.execute !== 'PRIMARY_179_STATIC') throw new Error('EXPLICIT_EXECUTION_CONSENT_REQUIRED');
const scannerRoot = resolve(import.meta.dirname, '../../..'), projectRoot = dirname(scannerRoot);
const rows = await readJsonl(args.manifest), quarantine = await readJsonl(args.quarantine), features = await readJsonl(args.features);
const sealed = sealPrimaryManifest(rows, new Set(quarantine.map(({ sampleId }) => sampleId)));
const featureById = new Map(features.map((row) => [row.sampleId, row]));
if (sealed.sampleIds.some((id) => !featureById.has(id))) throw new Error('FEATURE_MANIFEST_INCOMPLETE');
const scannerCommitSha = git('rev-parse', 'HEAD'), scannerBranch = git('branch', '--show-current');
const scannerVersion = JSON.parse(await readFile(join(scannerRoot, 'apps/scanner/package.json'), 'utf8')).version;
const hashes = {
  findingContractHash: await shaFile(join(scannerRoot, 'apps/scanner/src/domain/analysis.types.ts')),
  evidenceContractHash: await shaFile(join(scannerRoot, 'apps/scanner/src/evidence/normalizer/evidence-normalizer.types.ts')),
  evidenceMappingHash: await shaFile(join(scannerRoot, 'apps/scanner/src/evidence/normalizer/evidence-mapping.registry.ts')),
  rulesetHash: await shaFile(join(scannerRoot, 'apps/scanner/rules/custom-rule-analyzer.yml')),
  agentFindingContractHash: await shaFile(join(scannerRoot, 'apps/scanner/src/contracts/agent-analysis/agent-finding.v0.3.schema.json')),
  agentFindingProjectionHash: await shaFile(join(scannerRoot, 'apps/scanner/src/application/agent-input/agent-finding-projection.ts')),
};
if (hashes.rulesetHash !== '969bb8f9a053a2ec6c1bbb46805cfe0deadbf1aeccc68a129de35a4b9c6138f1') throw new Error('RULESET_BASELINE_MISMATCH');
const batchPolicy = { version:'1.0.0', primarySamples:179, concurrency:1, retry:0,
  calls:{guarddog:179,metadata:179,'custom-rule':179,total:537}, securityViolationAbortThreshold:2 };
const batchPolicyHash = sha(JSON.stringify(batchPolicy));
const sandboxPolicyHash = sha(JSON.stringify({ guarddog:EXTERNAL_GUARDDOG_SANDBOX_POLICY_VERSION,
  customRule:EXTERNAL_CUSTOM_RULE_SANDBOX_POLICY_VERSION, imageDigest:args.imageDigest }));
const runId = `dataset-analysis-${sha(JSON.stringify({ sealed:sealed.digest, scannerCommitSha, batchPolicyHash })).slice(0,20)}`;
await mkdir(args.output, { recursive:true });
const invocationBudget = new AtomicSmokeInvocationBudget(join(args.output, 'invocation-ledger.json'), {
  runId, executionPurpose:'PRIMARY_179_DATASET_BATCH', approvedSampleIds:sealed.sampleIds,
  maxUniqueSamples:179, maxCallsPerSampleAnalyzer:1, maxTotalCalls:537,
  maxCallsByAnalyzer:{guarddog:179,metadata:179,'custom-rule':179}, retryLimit:0, executionMode:'REAL',
});
await invocationBudget.initialize(); await invocationBudget.sealManifest(sealed.sampleIds);
const guardSandbox = new DockerExternalGuardDogRunner({runtime:'docker',image:args.image,expectedImageDigest:args.imageDigest,
  user:'65532:65532',pidsLimit:64,memory:'512m',cpus:'1',tmpfsSize:'64m',timeoutMs:120000,maxOutputBytes:4*1024*1024});
const customSandbox = new DockerExternalCustomRuleRunner({runtime:'docker',image:args.image,expectedImageDigest:args.imageDigest,
  expectedSemgrepVersion:'1.172.0',expectedRulesetSha256:hashes.rulesetHash,user:'65532:65532',pidsLimit:64,memory:'512m',cpus:'1',tmpfsSize:'64m',timeoutMs:120000,maxOutputBytes:4*1024*1024});
const guardDog = new GuardDogAnalyzer({executable:'guarddog',toolVersion:'3.1.0',workspaceRoot:tmpdir(),timeoutMs:120000,killGraceMs:1000,sandboxMode:'DISABLED',maxOutputBytes:4*1024*1024},{externalProcessRunner:guardSandbox});
const customRule = new CustomRuleAnalyzer({semgrepBin:'semgrep',ruleConfigPath:join(scannerRoot,'apps/scanner/rules/custom-rule-analyzer.yml'),timeoutMs:120000,ruleVersion:hashes.rulesetHash},customSandbox);
const metadata = new MetadataAnalyzer(), identityVerifier = new PackageIdentityVerifier(), artifactHasher = new ArtifactHasher();
const runtimeRecords=[], failures=[]; let securityViolations=0;

for (let index=0; index<sealed.sampleIds.length; index++) {
  const sampleId=sealed.sampleIds[index], row=rows.find(x=>x.sampleId===sampleId), feature=featureById.get(sampleId);
  const allowedRoot=resolve(args.artifactRoot,sampleId), packageRoot=resolve(allowedRoot,'files',feature.structure.packageRoot);
  const archivePath=resolve(args.archiveRoot,sampleId,basename(feature.identity.archivePath));
  const identity={sampleId,archiveSha256:row.sampleArtifactHash,scannerCommitSha,imageDigest:args.imageDigest,guardDogVersion:'3.1.0',semgrepVersion:'1.172.0',rulesetHash:hashes.rulesetHash,
    metadataVersion:metadata.version,findingContractHash:hashes.findingContractHash,evidenceContractHash:hashes.evidenceContractHash,evidenceMappingHash:hashes.evidenceMappingHash,
    agentFindingContractHash:hashes.agentFindingContractHash,agentFindingProjectionHash:hashes.agentFindingProjectionHash,sandboxPolicyHash,batchPolicyHash};
  const cacheIdentityHash=batchIdentityHash(identity), sampleDir=join(args.output,'samples',sampleId), resultFile=join(sampleDir,'result.json');
  if (args.resume) {
    const cached=await readJsonOptional(resultFile);
    if (isReusableSuccess(cached,cacheIdentityHash) && await verifySampleHashes(sampleDir,cached.outputHashes)) { runtimeRecords.push({sampleId,status:'COMPLETED',resumed:true,durationMs:0});await progress(index);continue; }
    const cachedFailure=await readJsonOptional(join(args.output,'failures',`${sampleId}.json`));
    if(cachedFailure?.cacheIdentityHash===cacheIdentityHash){failures.push(cachedFailure);if(/WRITE|SANDBOX|NETWORK|HASH_MISMATCH|PATH_/u.test(cachedFailure.reasonCode??''))securityViolations++;runtimeRecords.push({sampleId,status:'FAILED',resumed:true,durationMs:0});await progress(index);continue;}
    if(cached?.cacheIdentityHash===cacheIdentityHash&&cached.complete===true&&cached.status!=='COMPLETED'){
      const failure={sampleId,status:cached.status,analyzers:cached.analyzers,cacheIdentityHash,ref:`samples/${sampleId}/result.json`};
      failures.push(failure);runtimeRecords.push({sampleId,status:cached.status,resumed:true,durationMs:0});await progress(index);continue;
    }
  }
  const started=performance.now();
  try {
    if (row.qcStatus!=='ELIGIBLE'||row.sampleArtifactHash!==feature.identity.archiveSha256) throw new Error('MANIFEST_IDENTITY_MISMATCH');
    if (!await isDirectory(packageRoot)||!await isDirectory(allowedRoot)) throw new Error('ARTIFACT_PATH_INVALID');
    if (await artifactHasher.hash(archivePath)!==row.sampleArtifactHash) throw new Error('ARCHIVE_HASH_MISMATCH');
    let evidenceSequence=0;
    const service=new LocalStaticAnalysisService({guardDogAnalyzer:guardDog,customRuleAnalyzer:customRule,metadataAnalyzer:metadata,
      packageIdentityVerifier:identityVerifier,integrityVerifier:{verify:async req=>req.sampleId===sampleId&&await artifactHasher.hash(archivePath)===req.subject.artifactSha256},
      evidenceNormalizer:new EvidenceNormalizer(undefined,()=>`dataset-evidence:${sampleId}:${String(++evidenceSequence).padStart(6,'0')}`,()=>new Date(0)),
      semgrepAvailability:async()=>({available:true}),guardDogSandbox:guardSandbox,customRuleSandbox:customSandbox,
      invocationBudget,invocationBackendAttestation:'VERIFIED_EXTERNAL_CONTAINER'},
    {scannerRepositoryRoot:scannerRoot,projectRoot,scannerCommitSha,scannerBranch,scannerVersion,guardDogToolVersion:'3.1.0',
      findingSchemaHash:hashes.findingContractHash,evidenceSchemaHash:hashes.evidenceContractHash,rulesetHash:hashes.rulesetHash});
    const analysis=await service.analyze({scanId:`dataset-batch:${sampleId}`,sampleId,packageRoot,allowedArtifactRoot:allowedRoot,
      subject:{ecosystem:'npm',name:feature.identity.packageName,version:feature.identity.packageVersion,artifactSha256:row.sampleArtifactHash}});
    await validateReferences(analysis,packageRoot,sampleId);
    const projection=projectAgentFindingsV0_3(analysis.analyzerResults.map(({result})=>result),hashes.findingContractHash,hashes.agentFindingContractHash);
    if(projection.failures.length)throw new Error(`AGENT_FINDING_PROJECTION_FAILED:${projection.failures.map(x=>x.code).join(',')}`);
    validateAtomicEvidenceCompatibilityV0_3(analysis.atomicEvidences,projection.findings,row.sampleArtifactHash);
    const canonical={schemaVersion:'1.0.0',sampleId,archiveSha256:row.sampleArtifactHash,packageIdentity:{ecosystem:'npm',name:feature.identity.packageName,version:feature.identity.packageVersion},
      status:analysis.status,analyzers:analysis.analyzerResults.map(x=>({name:x.name,status:x.status,reasonCode:x.reasonCode??null,findingCount:x.result.findings.length,errors:x.result.errors})),
      findings:analysis.findings,agentFindingsV0_3:projection.findings,atomicEvidences:analysis.atomicEvidences,correlatedEvidences:[],failures:analysis.failures,complete:true,cacheIdentityHash};
    const provenance={...identity,executionMode:'LOCAL_STATIC',artifactReference:`${sampleId}/files/${feature.structure.packageRoot}`,relativePackageRoot:analysis.provenance.relativePackageRoot,
      packageTreeDigest:{before:analysis.provenance.packageTreeDigest,after:analysis.provenance.packageTreeDigest,equal:true},networkIsolationMode:analysis.provenance.networkIsolationMode,customRuleSandbox:analysis.provenance.customRuleSandbox,
      agentFindingProjection:projection.provenance,agentFindingContractHash:hashes.agentFindingContractHash,agentFindingProjectionImplementationHash:hashes.agentFindingProjectionHash,
      packageExecuted:false,lifecycleExecuted:false,correlatedEvidence:{supported:false,status:'NOT_SUPPORTED'}};
    const files={'scanner-findings.json':canonical.findings,'agent-findings.v0.3.json':canonical.agentFindingsV0_3,'atomic-evidences.json':canonical.atomicEvidences,'provenance.json':provenance};
    const outputHashes=Object.fromEntries(await Promise.all(Object.entries(files).map(async([name,value])=>[name,sha(json(value))])));
    const finalResult={...canonical,outputHashes}; outputHashes['result.json']=sha(json(finalResult));
    await mkdir(sampleDir,{recursive:true}); for(const [name,value] of Object.entries(files)) await atomic(join(sampleDir,name),json(value)); await atomic(resultFile,json(finalResult));
    if (analysis.status!=='COMPLETED') failures.push({sampleId,status:analysis.status,analyzers:canonical.analyzers,ref:`samples/${sampleId}/result.json`});
    runtimeRecords.push({sampleId,status:analysis.status,resumed:false,durationMs:Math.max(0,performance.now()-started)});
    if (analysis.provenance.networkIsolationMode!=='VERIFIED_NETWORK_NONE'||(analysis.provenance.customRuleSandbox!==undefined&&analysis.provenance.customRuleSandbox.mode!=='VERIFIED_NETWORK_NONE')) securityViolations++;
  } catch(error) {
    const message=error instanceof Error?error.message:'UNKNOWN_FAILURE'; const security=/WRITE|SANDBOX|NETWORK|HASH_MISMATCH|PATH_/u.test(message); if(security)securityViolations++;
    const failure={sampleId,status:'FAILED',reasonCode:message.split(':')[0],message:sanitize(message),cacheIdentityHash}; failures.push(failure);
    await atomic(join(args.output,'failures',`${sampleId}.json`),json(failure)); runtimeRecords.push({sampleId,status:'FAILED',resumed:false,durationMs:Math.max(0,performance.now()-started)});
  }
  if (securityViolations>=2) throw new Error('REPEATED_SECURITY_VIOLATION');
  await progress(index);
}

const records=[]; for(const sampleId of sealed.sampleIds){const value=await readJsonOptional(join(args.output,'samples',sampleId,'result.json'));if(value)records.push(value);}
const resultIds=new Set(records.map(r=>r.sampleId));
const manifest=[...records.map(r=>({sampleId:r.sampleId,archiveSha256:r.archiveSha256,status:r.status,packageIdentity:r.packageIdentity,analyzers:r.analyzers,
  findingCount:r.findings.length,atomicEvidenceCount:r.atomicEvidences.length,correlatedEvidenceCount:0,resultRef:`samples/${r.sampleId}/result.json`,resultSha256:sha(json(r)),cacheIdentityHash:r.cacheIdentityHash})),
  ...failures.filter(f=>!resultIds.has(f.sampleId)).map(f=>{const row=rows.find(x=>x.sampleId===f.sampleId),feature=featureById.get(f.sampleId);return{sampleId:f.sampleId,archiveSha256:row.sampleArtifactHash,status:'FAILED',packageIdentity:{ecosystem:'npm',name:feature.identity.packageName,version:feature.identity.packageVersion},analyzers:[],findingCount:0,atomicEvidenceCount:0,correlatedEvidenceCount:0,failureRef:`failures/${f.sampleId}.json`,cacheIdentityHash:f.cacheIdentityHash};})].sort((a,b)=>a.sampleId.localeCompare(b.sampleId));
const findingRows=records.flatMap(r=>r.findings.map(finding=>({sampleId:r.sampleId,archiveSha256:r.archiveSha256,finding})));
const agentFindingRows=records.flatMap(r=>r.agentFindingsV0_3.map(finding=>({sampleId:r.sampleId,archiveSha256:r.archiveSha256,finding})));
const evidenceRows=records.flatMap(r=>r.atomicEvidences.map(evidence=>({sampleId:r.sampleId,archiveSha256:r.archiveSha256,evidence})));
const ledger=await invocationBudget.read(), statusDistribution=count(manifest,'status'), analyzerDistribution={};
for(const row of manifest)for(const a of row.analyzers){analyzerDistribution[a.name]??={};analyzerDistribution[a.name][a.status]=(analyzerDistribution[a.name][a.status]??0)+1;}
const summary={schemaVersion:'1.0.0',sealedSamples:179,attemptedSamples:runtimeRecords.length,exportedSamples:records.length,failureSamples:failures.length,statusDistribution,analyzerDistribution,
  findingCount:findingRows.length,atomicEvidenceCount:evidenceRows.length,correlatedEvidenceCount:0,securityViolations,invocationCalls:ledger.calls.length,resumedSamples:runtimeRecords.filter(x=>x.resumed).length};
const provenance={schemaVersion:'1.0.0',runId,scannerCommitSha,scannerBranch,scannerVersion,imageReference:args.image,imageDigest:args.imageDigest,guardDogVersion:'3.1.0',semgrepVersion:'1.172.0',rulesetHash:hashes.rulesetHash,
  sealedManifestDigest:sealed.digest,batchPolicy,batchPolicyHash,sandboxPolicyHash,findingContractHash:hashes.findingContractHash,evidenceContractHash:hashes.evidenceContractHash,evidenceMappingHash:hashes.evidenceMappingHash,
  agentFindingContractHash:hashes.agentFindingContractHash,agentFindingProjectionImplementationHash:hashes.agentFindingProjectionHash,
  priorSmokeHistory:'apps/scanner/docs/local-static-smoke-history.v1.json',safety:{networkMode:'NONE',packageExecuted:false,lifecycleExecuted:false,entryPointsExecuted:false,downloads:0,extractions:0,llmCalls:0}};
await atomic(join(args.output,'manifest.jsonl'),jsonl(manifest));await atomic(join(args.output,'findings.jsonl'),jsonl(findingRows));await atomic(join(args.output,'agent-findings.v0.3.jsonl'),jsonl(agentFindingRows));await atomic(join(args.output,'atomic-evidences.jsonl'),jsonl(evidenceRows));await atomic(join(args.output,'correlated-evidences.jsonl'),'');
await atomic(join(args.output,'failure-index.json'),json(failures));await atomic(join(args.output,'summary.json'),json(summary));await atomic(join(args.output,'provenance.json'),json(provenance));
await atomic(join(args.output,'runs',`${runId}.json`),json({runId,runtimeRecords,summary}));
process.stdout.write(`${JSON.stringify({runId,summary},null,2)}\n`);

function parseArgs(xs){const o={resume:false};for(let i=0;i<xs.length;i++){const x=xs[i];if(x==='--resume'){o.resume=true;continue;}if(x.startsWith('--'))o[x.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=xs[++i];}return o;}
async function readJsonl(f){return(await readFile(f,'utf8')).split(/\r?\n/u).filter(Boolean).map(JSON.parse);} async function readJsonOptional(f){try{return JSON.parse(await readFile(f,'utf8'));}catch(e){if(e.code==='ENOENT')return null;return null;}}
function sha(x){return createHash('sha256').update(x).digest('hex');}
async function shaFile(f){return sha(await readFile(f));}
function json(x){return `${JSON.stringify(x,null,2)}\n`;}
function jsonl(xs){return xs.length?`${xs.map(JSON.stringify).join('\n')}\n`:'';}
async function atomic(f,b){await mkdir(dirname(f),{recursive:true});const t=`${f}.${process.pid}.tmp`;await writeFile(t,b,{flag:'wx'});await rename(t,f);} function git(...a){return execFileSync('git',a,{cwd:scannerRoot,encoding:'utf8'}).trim();}
async function isDirectory(p){try{return(await stat(p)).isDirectory();}catch{return false;}} function sanitize(s){return s.replaceAll(args.artifactRoot,'<ARTIFACT_ROOT>').replaceAll(args.archiveRoot,'<ARCHIVE_ROOT>').replace(/\/Users\/[^/]+/gu,'<HOME>');}
function count(xs,k){return xs.reduce((o,x)=>(o[x[k]]=(o[x[k]]??0)+1,o),{});} async function verifySampleHashes(dir,hashes){if(!hashes)return false;for(const[n,h]of Object.entries(hashes)){if(n==='result.json')continue;try{if(await shaFile(join(dir,n))!==h)return false;}catch{return false;}}return true;}
async function progress(index){if((index+1)%25===0||index+1===sealed.sampleIds.length)await atomic(join(args.output,'progress.json'),json({runId,processed:index+1,total:179,statusDistribution:count(runtimeRecords,'status'),failureSamples:failures.length,securityViolations}));process.stdout.write(`[${index+1}/179] ${sealed.sampleIds[index]} ${runtimeRecords.at(-1).status}\n`);}
async function validateReferences(a,root,id){const ids=new Set();for(const f of a.findings){if(ids.has(f.findingId))throw Error(`DUPLICATE_FINDING:${id}`);ids.add(f.findingId);const locs=f.data?.locations??[f.location];for(const l of locs){if(l?.type!=='SOURCE_FILE')continue;if(typeof l.path!=='string'||l.path.startsWith('/')||l.path.includes('..'))throw Error(`PATH_INVALID:${id}`);const p=resolve(root,l.path);if(!p.startsWith(`${resolve(root)}/`))throw Error(`PATH_ESCAPE:${id}`);let text;try{text=await readFile(p,'utf8');}catch{throw Error(`FINDING_FILE_MISSING:${id}`);}const lines=text.split('\n').length;if(l.startLine&&(l.startLine<1||l.startLine>lines))throw Error(`FINDING_RANGE_INVALID:${id}`);if(l.endLine&&(l.endLine<1||l.endLine>lines))throw Error(`FINDING_RANGE_INVALID:${id}`);}}
  const eids=new Set();for(const e of a.atomicEvidences){if(eids.has(e.evidenceId))throw Error(`DUPLICATE_EVIDENCE:${id}`);eids.add(e.evidenceId);for(const s of e.sources)if(!ids.has(s.rawFindingId))throw Error(`DANGLING_EVIDENCE:${id}`);}const text=JSON.stringify(a);if(text.includes('/analysis/package')||text.includes('/Users/')||text.includes('/private/tmp/'))throw Error(`PATH_LEAK:${id}`);}
