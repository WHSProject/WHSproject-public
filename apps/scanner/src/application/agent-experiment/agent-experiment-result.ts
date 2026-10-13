import type { AgentExperimentRequestV0_3 } from './agent-experiment.types';
import { AgentOutputValidatorService } from '../../llm-agent/agent-output-validator.service';
import type { AgentAnalysisOutput, ValidatedAgentAnalysisResult } from '../../llm-agent/output.contract';

export function validateAgentExperimentOutput(
  request: AgentExperimentRequestV0_3,
  output: AgentAnalysisOutput,
  validator = new AgentOutputValidatorService(),
): ValidatedAgentAnalysisResult {
  return validator.validateSuppliedSlices(request, output);
}
