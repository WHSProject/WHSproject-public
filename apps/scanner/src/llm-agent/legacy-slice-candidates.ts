import type { AgentFinding, AgentPackageContext } from './agent.contract';

/**
 * Finding- and entry-point-based target selection used by the legacy single-root
 * slice service. Kept separate so an upstream fallback planner can reuse it when
 * Planning is unavailable; the Plan-based ArtifactCodeSliceBuilder does not use it.
 */
export interface LegacySliceCandidate { file: string; line: number | null; reason: string; findingIds: string[] }

function entryFiles(context: AgentPackageContext): LegacySliceCandidate[] {
  const candidates: LegacySliceCandidate[] = [];
  for (const script of context.lifecycleScripts) {
    const match = /(?:^|\s)(?:node\s+)?(\.?\.?\/[\w./-]+\.[cm]?js)(?:\s|$)/u.exec(script.command);
    if (match?.[1]) candidates.push({ file: match[1].replace(/^\.\//u, ''), line: null, reason: `lifecycle:${script.name}`, findingIds: [] });
  }
  for (const entry of context.entryPoints) candidates.push({ file: entry.value.replace(/^\.\//u, ''), line: null, reason: `entry:${entry.type}`, findingIds: [] });
  return candidates;
}

/** Finding locations first, then lifecycle-script files, then package entry points. */
export function selectLegacySliceCandidates(context: AgentPackageContext, findings: readonly AgentFinding[]): LegacySliceCandidate[] {
  const candidates: LegacySliceCandidate[] = findings.map((finding) => ({ file: finding.location?.file ?? '', line: finding.location?.startLine ?? null, reason: `finding:${finding.findingId}`, findingIds: [finding.findingId] }));
  candidates.push(...entryFiles(context));
  return candidates;
}
