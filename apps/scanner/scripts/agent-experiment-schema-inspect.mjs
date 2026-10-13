import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AGENT_EXPERIMENT_OUTPUT_SCHEMA,
  AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256,
  AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0,
  AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0_SHA256,
  AGENT_EXPERIMENT_OUTPUT_SCHEMA_VERSION,
} from '../dist/application/agent-experiment/agent-experiment-output.schema.js';
import { createStructuredOutputProbePlan, inspectStructuredOutputSchema } from '../dist/application/agent-experiment/agent-experiment-structured-output-linter.js';

export function inspect() {
  const current = inspectStructuredOutputSchema(AGENT_EXPERIMENT_OUTPUT_SCHEMA);
  const previous = inspectStructuredOutputSchema(AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0);
  return {
    schemaVersion: AGENT_EXPERIMENT_OUTPUT_SCHEMA_VERSION,
    schemaSha256: AGENT_EXPERIMENT_OUTPUT_SCHEMA_SHA256,
    validForConfiguredSubset: current.validForConfiguredSubset,
    metrics: current.metrics,
    keywordInventory: current.keywordInventory,
    violations: current.violations,
    previousSchema: { version: 'scanner-agent-experiment-output/1.0.0', schemaSha256: AGENT_EXPERIMENT_OUTPUT_SCHEMA_V1_0_SHA256,
      metrics: previous.metrics, keywordInventory: previous.keywordInventory, violations: previous.violations },
    probePlan: createStructuredOutputProbePlan(AGENT_EXPERIMENT_OUTPUT_SCHEMA),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.stdout.write(`${JSON.stringify(inspect(), null, 2)}\n`);
