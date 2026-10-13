import { isDeepStrictEqual } from 'node:util';
import type { AtomicEvidenceV0_1 } from '../../evidence/normalizer/evidence-normalizer.types';
import type { CapabilityPreservationReport, CapabilityObservation } from '../../analyzers/obfuscation/obfuscation.types';
import type { AgentCapabilityPreservationReport, AgentCapabilityObservation, MissingDataV0_3, Tier3ExecutionInput } from './agent-analysis-input.contract';

function projectObservation(observation: CapabilityObservation): AgentCapabilityObservation {
  const { derivedFrom, ...rest } = observation;
  return { ...rest, ...(derivedFrom === undefined ? {} : {
    derivedFrom: { file: derivedFrom.path,
      ...(derivedFrom.startLine === undefined ? {} : { startLine: derivedFrom.startLine }),
      ...(derivedFrom.endLine === undefined ? {} : { endLine: derivedFrom.endLine }) },
  }) };
}

/** Adapt to the existing Agent schema, without changing upstream/Evidence data. */
export function projectAgentCapabilityReport(report: CapabilityPreservationReport): AgentCapabilityPreservationReport {
  const clone = structuredClone(report);
  return { ...clone, files: clone.files.map((file) => {
    const { comparisons, ...validation } = file.validation;
    return { ...file, validation: { ...validation,
      ...(comparisons === undefined ? {} : { comparisons: comparisons.map((comparison) => ({
        ...comparison, original: comparison.original.map(projectObservation), deobfuscated: comparison.deobfuscated.map(projectObservation),
      })) }),
    } };
  }) };
}

/**
 * Agent-only, lossless projection of optional per-evidence capability reports.
 * The complete report remains in capabilityPreservation.files[i].validation.
 * Never remove an Evidence, location, binding, or a non-identical report.
 */
export function projectCapabilityReports(execution: Tier3ExecutionInput): {
  atomicEvidences: AtomicEvidenceV0_1[];
  sharedReports: MissingDataV0_3[];
} {
  // Compare the same cloned data representation on both sides (including when
  // callers supply values from another JS realm). Clone shared reports once.
  const files = structuredClone(execution.capabilityPreservation?.files ?? []);
  const sharedReports: MissingDataV0_3[] = [];
  const atomicEvidences = execution.atomicEvidences.map((evidence, evidenceIndex) => {
    const clone = structuredClone(evidence);
    if (clone.capabilityPreservation === undefined || clone.analysisPass !== 'TIER2') return clone;
    const bindings = execution.bindings.evidenceBindings.filter((binding) => binding.evidenceId === clone.evidenceId);
    if (bindings.length === 0 || bindings.some((binding) => (
      execution.artifacts.describe(binding.artifactId)?.representation !== 'DEOBFUSCATED'
    ))) return clone;

    const matches = files.flatMap((file, fileIndex) => (
      bindings.every((binding) => file.deobfuscatedPaths.includes(binding.filePath))
        && isDeepStrictEqual(file.validation, clone.capabilityPreservation) ? [fileIndex] : []
    ));
    // Ambiguous or multi-file associations retain the original, even if values
    // happen to match. A single explicit common location must reconstruct it.
    if (matches.length !== 1) return clone;
    const reference: MissingDataV0_3 = {
      field: `atomicEvidences[${evidenceIndex}].capabilityPreservation`,
      reason: `Duplicate validation retained at capabilityPreservation.files[${matches[0]}].validation; derivedFrom.file there corresponds to Evidence derivedFrom.path. No validation data was discarded.`,
    };
    // Account for the optional field key and comma as well as the reference.
    // Small reports stay inline when sharing would not reduce serialized size.
    const removedBytes = Buffer.byteLength(`,"capabilityPreservation":${JSON.stringify(clone.capabilityPreservation)}`, 'utf8');
    const addedBytes = Buffer.byteLength(JSON.stringify(reference), 'utf8') + 1;
    if (removedBytes <= addedBytes) return clone;
    delete clone.capabilityPreservation;
    sharedReports.push(reference);
    return clone;
  });
  return { atomicEvidences, sharedReports };
}
