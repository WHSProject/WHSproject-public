import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AgentCodeSlice, AgentFinding, AgentMissingData, AgentPackageContext, CodeSlicePolicy } from './agent.contract';
import { selectLegacySliceCandidates } from './legacy-slice-candidates';
import { readSafeCodeFile } from './safe-code-reader';

export interface CodeSliceBuildResult { slices: AgentCodeSlice[]; missingData: AgentMissingData[] }

@Injectable()
export class LlmAgentCodeSliceService {
  async build(root: string, context: AgentPackageContext, findings: readonly AgentFinding[], policy: CodeSlicePolicy): Promise<CodeSliceBuildResult> {
    const missingData: AgentMissingData[] = [];
    const candidates = selectLegacySliceCandidates(context, findings);
    if (candidates.length === 0) missingData.push({ type: 'CODE_CANDIDATE', description: 'No finding location or package entry point', impact: 'Initial source code unavailable' });
    const slices: AgentCodeSlice[] = [];
    let remaining = Math.min(policy.maxInitialCodeLines, policy.maxTotalCodeLines);
    for (const candidate of candidates) {
      if (remaining <= 0 || slices.length >= policy.maxInitialSlices) break;
      if (!candidate.file) { missingData.push({ type: 'FINDING_LOCATION', description: 'Finding has no file path', impact: 'Entry point fallback used when available' }); continue; }
      try {
        const source = await readSafeCodeFile(root, candidate.file, policy.maxFileSizeBytes);
        const count = source.lines.length;
        let start = candidate.line === null ? 1 : Math.max(1, candidate.line - 15);
        let end = candidate.line === null ? Math.min(count, policy.maxLinesPerSlice) : Math.min(count, start + policy.maxLinesPerSlice - 1, candidate.line + 15);
        if (candidate.line !== null && (!Number.isSafeInteger(candidate.line) || candidate.line < 1 || candidate.line > count)) throw new Error('Invalid finding line');
        if (candidate.line === null && count > policy.maxLinesPerSlice) {
          const importIndex = source.lines.findIndex((line) => /^\s*(?:import\s|(?:const|let|var)\s+\w+\s*=\s*require\()/u.test(line));
          const riskIndex = source.lines.findIndex((line) => /\b(?:exec|spawn|fetch|writeFile|readFile|eval)\s*\(/u.test(line));
          const anchor = importIndex >= 0 ? importIndex + 1 : riskIndex >= 0 ? riskIndex + 1 : 1;
          start = Math.max(1, anchor - 5);
          end = Math.min(count, start + policy.maxLinesPerSlice - 1);
        }
        const overlap = slices.find((slice) => slice.file === source.file && start <= slice.endLine + 1 && end >= slice.startLine - 1);
        if (overlap) {
          const mergedStart = Math.min(overlap.startLine, start);
          const mergedEnd = Math.max(overlap.endLine, end);
          const increase = mergedEnd - mergedStart + 1 - (overlap.endLine - overlap.startLine + 1);
          if (mergedEnd - mergedStart + 1 <= policy.maxLinesPerSlice && increase <= remaining) {
            overlap.startLine = mergedStart; overlap.endLine = mergedEnd;
            overlap.content = source.lines.slice(mergedStart - 1, mergedEnd).join('\n');
            overlap.selectionReason = [...new Set([...overlap.selectionReason.split(';'), candidate.reason])].join(';');
            overlap.relatedFindingIds = [...new Set([...overlap.relatedFindingIds, ...candidate.findingIds])];
            remaining -= increase;
          } else {
            overlap.relatedFindingIds = [...new Set([...overlap.relatedFindingIds, ...candidate.findingIds])];
            overlap.selectionReason = [...new Set([...overlap.selectionReason.split(';'), candidate.reason])].join(';');
          }
          continue;
        }
        end = Math.min(end, start + Math.min(policy.maxLinesPerSlice, remaining) - 1);
        if (end < start) break;
        slices.push({ sliceId: randomUUID(), file: source.file, startLine: start, endLine: end, content: source.lines.slice(start - 1, end).join('\n'), contentRedacted: false, selectionReason: candidate.reason, relatedFindingIds: candidate.findingIds });
        remaining -= end - start + 1;
      } catch (error) {
        missingData.push({ type: 'CODE_FILE', description: `Candidate omitted: ${error instanceof Error ? error.message : 'unavailable'}`, impact: 'Code slice omitted' });
      }
    }
    return { slices, missingData };
  }
}
