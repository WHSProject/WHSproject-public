import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { evaluateTier3Escalation } from '../dist/llm-agent/tier3-escalation-gate.js';

const inputPath = resolve(process.env.OMC_TIER2_REPORT ?? resolve(import.meta.dirname, '../../../reports/validation/tier2-omcbench-2026-09-23.json'));
const outputPath = resolve(process.env.OMC_GATE_OUTPUT ?? resolve(import.meta.dirname, '../../../reports/validation/tier3-gate-omc-profiles-2026-09-28.json'));
const report = JSON.parse(await readFile(inputPath, 'utf8'));
const profiles = ['CONSERVATIVE', 'BALANCED', 'LLM_MINIMAL'];
const samples = report.cases.map((item) => ({
  sampleId: item.name,
  truth: item.label === 'malicious' ? 'MALICIOUS' : 'BENIGN',
  tier2Entered: item.candidateFiles > 0,
  restore: {
    outputRoot: '/benchmark/derived',
    restored: (item.candidates ?? []).filter((candidate) => candidate.restoreStatus === 'RESTORED' || candidate.restoreStatus === 'PARTIAL_RESTORED').map((candidate) => ({ status: candidate.restoreStatus, path: candidate.path, limitations: candidate.limitations ?? [] })),
    unresolved: (item.candidates ?? []).filter((candidate) => ['UNRESOLVED', 'SKIPPED', 'FAILED'].includes(candidate.restoreStatus)).map((candidate) => ({ status: candidate.restoreStatus, path: candidate.path, reason: candidate.reason ?? 'NO_SUPPORTED_TRANSFORM', limitations: candidate.limitations ?? [], stageResults: [] })),
    durationMs: 0,
    budgetExceeded: false,
  },
  tier2Handoff: item.candidateFiles > 0 ? {
    artifact: { artifactId: `artifact:${item.name}`, representation: 'DEOBFUSCATED', analysisPass: 'TIER2', contentSha256: 'b'.repeat(64), derivedFromArtifactId: 'artifact:original', lineageStatus: 'UNMAPPED', producer: 'omc-benchmark', producerVersion: '1' },
    artifactRoot: '/benchmark/derived',
    findings: [],
    atomicEvidences: [],
    findingBindings: [],
    evidenceBindings: [],
    limitations: (item.candidates ?? []).flatMap((candidate) => (candidate.limitations ?? []).map((code) => ({ filePath: candidate.path, code }))),
  } : undefined,
}));

const results = profiles.map((profile) => {
  const decisions = samples.map((sample) => {
    const started = performance.now();
    const decision = evaluateTier3Escalation({
      tier1Results: [],
      tier1Evidences: [],
      profile,
      ...(sample.tier2Handoff === undefined ? {} : { tier2Handoff: sample.tier2Handoff }),
      ...(sample.restore === undefined ? {} : { restore: sample.restore }),
    });
    return { sampleId: sample.sampleId, tier2Entered: sample.tier2Entered, decision, decisionMs: performance.now() - started };
  });
  const escalated = decisions.filter((item) => item.decision.shouldEscalate);
  const reasonCounts = {};
  for (const item of escalated) for (const reason of item.decision.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  return {
    profile,
    tier1CompletedProxyRate: (samples.length - samples.filter((sample) => sample.tier2Entered).length) / samples.length,
    tier2EntryRate: samples.filter((sample) => sample.tier2Entered).length / samples.length,
    tier3EscalationRate: escalated.length / samples.length,
    llmFreeCompletionRate: (samples.length - escalated.length) / samples.length,
    gateBeforeRate: samples.filter((sample) => sample.tier2Entered).length / samples.length,
    expectedLlmCallReduction: (samples.filter((sample) => sample.tier2Entered).length - escalated.length) / samples.length,
    reasonCounts,
    decisionLatencyMs: percentile(decisions.map((item) => item.decisionMs)),
    rows: decisions.map((item) => ({ sampleId: item.sampleId, tier2Entered: item.tier2Entered, restoreStatuses: item.decision.restoreStatuses, escalated: item.decision.shouldEscalate, reasons: item.decision.reasons })),
  };
});

const output = {
  source: { inputPath, dataset: report.source, caveat: 'Tier1 results and Tier2 normalized findings were not present in the OMC runner output; this is a Tier2 restore-state gate proxy, not a full production gate measurement.' },
  corpus: { samples: samples.length, benign: samples.filter((sample) => sample.truth === 'BENIGN').length, malicious: samples.filter((sample) => sample.truth === 'MALICIOUS').length, tier2Entered: samples.filter((sample) => sample.tier2Entered).length },
  profiles: results,
  latency: { beforeTier3P50Ms: report.metrics.packageTotalP50Ms, beforeTier3P95Ms: report.metrics.packageTotalP95Ms, afterTier3P50Ms: null, afterTier3P95Ms: null, reason: 'No Tier3 provider was executed; only gate decision latency was measured.' },
  selection: 'BALANCED is the default: it ties LLM_MINIMAL on this corpus (lowest observed escalation) while retaining semantic/weak-signal escalation when evidence is insufficient. This selection is provisional because Tier1/Tier2 Evidence was unavailable in the OMC output.',
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function percentile(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null };
}
