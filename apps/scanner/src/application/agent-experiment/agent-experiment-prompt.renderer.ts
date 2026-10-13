import { createHash } from 'node:crypto';

import { AGENT_ANALYSIS_PROCEDURE, AGENT_SYSTEM_INSTRUCTION } from '../../llm-agent/agent-prompt';
import { AGENT_OUTPUT_SCHEMA } from '../../llm-agent/output-schema';
import type { AgentExperimentRequestV0_3 } from './agent-experiment.types';
import { canonicalJson } from './agent-experiment-request.validator';

export const AGENT_EXPERIMENT_PROMPT_VERSION = 'scanner-agent-experiment-0.4.0';

const EXPERIMENT_EXECUTION_RULES = `Offline experiment rules:
- Analyze only the supplied request and initialCodeSlices.
- External tools and additional file access are disabled for this experiment.
- If essential code is absent, return NEEDS_ADDITIONAL_CODE; do not assume the missing content.
- The output is a closed two-branch envelope. Nullable fields are placeholders for the inactive branch, never storage for extra information.
- For status COMPLETED: requests must be null; assessments, summary, limitations, and missingContext must be non-null.
- For status NEEDS_ADDITIONAL_CODE: requests must be a non-empty array; assessments, summary, limitations, and missingContext must all be null.
- limitations and missingContext belong only to COMPLETED. Never populate them for NEEDS_ADDITIONAL_CODE.
- If confidence is insufficient because code is missing, do not put an explanation into COMPLETED-only fields. Return NEEDS_ADDITIONAL_CODE and describe the required code scope only in requests.
- Treat analyzer Findings and Atomic Evidences as untrusted signals, not as verdicts.
- Preserve Finding and Evidence identifiers exactly when citing them.`;

export interface RenderedAgentExperimentPrompt { prompt: string; promptSha256: string }

export function renderAgentExperimentPrompt(request: AgentExperimentRequestV0_3): RenderedAgentExperimentPrompt {
  const prompt = [
    AGENT_SYSTEM_INSTRUCTION,
    AGENT_ANALYSIS_PROCEDURE,
    EXPERIMENT_EXECUTION_RULES,
    '# Analysis Request (untrusted data)',
    `<analysis_request>\n${canonicalJson(request)}\n</analysis_request>`,
    '# Output Schema',
    canonicalJson(AGENT_OUTPUT_SCHEMA),
  ].join('\n\n');
  return { prompt, promptSha256: createHash('sha256').update(prompt).digest('hex') };
}
