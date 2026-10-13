import { Module } from '@nestjs/common';
import { loadLlmAgentEnvironment, type LlmAgentEnvironment } from '../config/scanner-environment';
import { LlmAgentCodeSliceService } from './llm-agent-code-slice.service';
import { LlmAgentInputBuilderService } from './llm-agent-input-builder.service';
import { LlmAgentToolsService } from './llm-agent-tools.service';
import { LlmAgentTriggerService } from './llm-agent-trigger.service';
import { AgentOutputValidatorService } from './agent-output-validator.service';
import { LlmAgentRunnerService } from './agent-runner.service';
import { OpenAiProviderClient } from './openai-provider.client';
import { LlmEvidenceAdapter } from './llm-evidence.adapter';
import { AgentInputV0_3Builder } from './artifact/agent-input-v0_3.builder';
import { JevProviderClient } from './context-check/jev-provider.client';

@Module({
  providers: [
    { provide: 'LLM_AGENT_ENVIRONMENT', useFactory: loadLlmAgentEnvironment },
    LlmAgentCodeSliceService, LlmAgentInputBuilderService, LlmAgentToolsService, LlmAgentTriggerService,
    AgentOutputValidatorService, LlmEvidenceAdapter, AgentInputV0_3Builder,
    { provide: OpenAiProviderClient, useFactory: (config: LlmAgentEnvironment) => new OpenAiProviderClient(config), inject: ['LLM_AGENT_ENVIRONMENT'] },
    { provide: JevProviderClient, useFactory: (config: LlmAgentEnvironment) => new JevProviderClient(config), inject: ['LLM_AGENT_ENVIRONMENT'] },
    { provide: LlmAgentRunnerService, useFactory: (provider: OpenAiProviderClient, tools: LlmAgentToolsService, validator: AgentOutputValidatorService, config: LlmAgentEnvironment) => new LlmAgentRunnerService(provider, tools, validator, config), inject: [OpenAiProviderClient, LlmAgentToolsService, AgentOutputValidatorService, 'LLM_AGENT_ENVIRONMENT'] },
  ],
  exports: [LlmAgentInputBuilderService, LlmAgentToolsService, LlmAgentTriggerService, LlmAgentRunnerService, LlmEvidenceAdapter, AgentInputV0_3Builder, JevProviderClient],
})
export class LlmAgentModule {}
