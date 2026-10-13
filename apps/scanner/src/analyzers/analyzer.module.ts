import { Module } from '@nestjs/common';

import {
  DEFAULT_CUSTOM_RULE_TIMEOUT_MS,
  loadGuardDogEnvironment,
  loadObfuscationGptEnvironment,
} from '../config/scanner-environment';
import { CustomRuleAnalyzer } from './custom-rule/custom-rule.analyzer';
import { GuardDogAnalyzer } from './guarddog/guarddog.analyzer';
import { MetadataAnalyzer } from './metadata/metadata.analyzer';
import { ObfuscationAnalyzer } from './obfuscation/obfuscation.analyzer';
import { OpenAiGptCodeAssistant } from './obfuscation/gpt-code-assistant';
import { GeminiCodeAssistant } from './obfuscation/gemini-code-assistant';
import { CODE_ASSISTANT_PROMPT_VERSION } from './obfuscation/gpt-code-assistant';
import { OBFUSCATION_ANALYZER_VERSION } from './obfuscation/obfuscation.analyzer';
import {
  BoundedLlmResultCache,
  CachedCodeUnderstandingAssistant,
} from './obfuscation/llm-request-cache';
import type { CodeUnderstandingAssistant } from './obfuscation/agent-analysis.types';

@Module({
  providers: [
    MetadataAnalyzer,
    {
      provide: CustomRuleAnalyzer,
      useFactory: (): CustomRuleAnalyzer => new CustomRuleAnalyzer({
        semgrepBin: 'semgrep',
        ruleConfigPath: 'rules/custom-rule-analyzer.yml',
        timeoutMs: DEFAULT_CUSTOM_RULE_TIMEOUT_MS,
      }),
    },
    {
      provide: GuardDogAnalyzer,
      useFactory: (): GuardDogAnalyzer => {
        const environment = loadGuardDogEnvironment();
        return new GuardDogAnalyzer({
          executable: environment.GUARDDOG_BIN,
          toolVersion: environment.GUARDDOG_VERSION,
          workspaceRoot: environment.SCANNER_TEMP_DIR,
          timeoutMs: environment.GUARDDOG_TIMEOUT_MS,
          killGraceMs: environment.GUARDDOG_KILL_GRACE_MS,
          sandboxMode: environment.GUARDDOG_SANDBOX_MODE,
          maxOutputBytes: environment.GUARDDOG_MAX_OUTPUT_BYTES,
        });
      },
    },
    {
      provide: ObfuscationAnalyzer,
      inject: [CustomRuleAnalyzer, GuardDogAnalyzer],
      useFactory: (
        customRuleAnalyzer: CustomRuleAnalyzer,
        guardDogAnalyzer: GuardDogAnalyzer,
      ): ObfuscationAnalyzer => {
        const environment = loadObfuscationGptEnvironment();
        const codeUnderstandingAssistant: CodeUnderstandingAssistant | undefined =
          environment.OBFUSCATION_GPT_MODE !== 'shadow'
            ? undefined
            : environment.OBFUSCATION_LLM_PROVIDER === 'gemini'
              ? new GeminiCodeAssistant({
                  apiKey: environment.GEMINI_API_KEY!,
                  model: environment.OBFUSCATION_GEMINI_MODEL,
                  baseUrl: environment.OBFUSCATION_GEMINI_BASE_URL,
                  timeoutMs: environment.OBFUSCATION_GPT_TIMEOUT_MS,
                  maxOutputTokens: environment.OBFUSCATION_GPT_MAX_OUTPUT_TOKENS,
                })
              : new OpenAiGptCodeAssistant({
                  apiKey: environment.OPENAI_API_KEY!,
                  model: environment.OBFUSCATION_GPT_MODEL,
                  baseUrl: environment.OBFUSCATION_GPT_BASE_URL,
                  timeoutMs: environment.OBFUSCATION_GPT_TIMEOUT_MS,
                  maxOutputTokens: environment.OBFUSCATION_GPT_MAX_OUTPUT_TOKENS,
                });
        const cachedAssistant = codeUnderstandingAssistant === undefined
          ? undefined
          : new CachedCodeUnderstandingAssistant(
              codeUnderstandingAssistant,
              {
                provider: environment.OBFUSCATION_LLM_PROVIDER,
                model: environment.OBFUSCATION_LLM_PROVIDER === 'gemini'
                  ? environment.OBFUSCATION_GEMINI_MODEL
                  : environment.OBFUSCATION_GPT_MODEL,
                promptVersion: CODE_ASSISTANT_PROMPT_VERSION,
                analyzerVersion: OBFUSCATION_ANALYZER_VERSION,
              },
              {
                enabled: environment.OBFUSCATION_LLM_CACHE_ENABLED,
                ttlMs: environment.OBFUSCATION_LLM_CACHE_TTL_MS,
                maxEntries: environment.OBFUSCATION_LLM_CACHE_MAX_ENTRIES,
              },
              new BoundedLlmResultCache(
                environment.OBFUSCATION_LLM_CACHE_TTL_MS,
                environment.OBFUSCATION_LLM_CACHE_MAX_ENTRIES,
              ),
            );
        return new ObfuscationAnalyzer(
          customRuleAnalyzer,
          guardDogAnalyzer,
          environment.OBFUSCATION_GPT_MODE,
          cachedAssistant,
        );
      },
    },
  ],
  exports: [
    MetadataAnalyzer,
    CustomRuleAnalyzer,
    GuardDogAnalyzer,
    ObfuscationAnalyzer,
  ],
})
export class AnalyzerModule {}
