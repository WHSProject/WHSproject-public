# Agent code-volume Luna experiment runner

## Scope

`scripts/agent-code-volume-luna.mjs` independently executes frozen code-volume inputs. It does not call the Scanner Orchestrator, static filter, Tier 2, Jev/context-check, Policy, DB, or production routing. The CLI reuses the production v0.3 Runner, output parser, artifact Validator, and LLM Evidence adapter without changing their operational defaults.

Tier 3 keeps two output-schema roles separate. `AGENT_OUTPUT_SCHEMA_V0_2` is the internal discriminated-union contract used by the prompt, Zod parser, and artifact Validator. `AGENT_OUTPUT_API_SCHEMA_V0_2` is the Responses API transport schema: it has one object root, represents branch-only fields as nullable, and is normalized back to the internal shape before the unchanged parser and Validator run. Both the production v0.3 Runner and this Luna harness send the transport schema with `strict: false`.

The transport schema is checked statically against the documented Structured Outputs subset and by API-free request tests. This does not prove that OpenAI accepts the request; acceptance remains unverified until a separately authorized live smoke succeeds.

Default behavior is dry-run. Network use requires the explicit `--live` flag and a non-empty `OPENAI_API_KEY` in the current process. The key is never accepted as a CLI argument or written to output.

## Frozen experiment configuration

| Field | Value | Reason |
| --- | --- | --- |
| Model | `gpt-5.6-luna` | Experiment decision; not a Scanner operational default |
| Reasoning effort | `medium` | Fixed for every condition; the model supports and defaults to medium |
| Endpoint | `https://api.openai.com` | Explicit experiment endpoint |
| `max_output_tokens` | 32,768 | Keeps one identical output/reasoning budget for all levels and exceeds OpenAI's initial 25,000-token reasoning/output reserve recommendation |
| Timeout | 180,000 ms | Independent experiment Runner setting for a reasoning request; does not alter `LLM_AGENT_TIMEOUT_MS` |
| Retries | 0 | Prevents an implicit second paid request |
| Provider-call limit | CLI `--max-calls`, default 2 | Hard process-local cap |
| Jev | disabled | The experiment compares supplied code only |
| Additional code | disabled | Prompt, input policy, and tool catalog all disable it; any model request is recorded without serving code |
| Storage | `store: false` | Requests are independent and no response ID is chained |

Official OpenAI documentation lists a 1,050,000-token context window, a 128,000-token maximum output, structured-output support, and `medium` reasoning for `gpt-5.6-luna`: <https://developers.openai.com/api/docs/models/gpt-5.6-luna>. OpenAI also documents that `max_output_tokens` includes visible output and reasoning tokens, reasoning tokens are a subset of output usage, and recommends initially reserving at least 25,000 output/reasoning tokens: <https://developers.openai.com/api/docs/guides/reasoning>.

The runner checks `estimated input tokens + 32,768 <= 1,050,000`. The input estimate remains the preparation harness's character/4 estimate, not an exact API tokenizer result. Actual API usage is stored separately when returned.

## Input integrity

For every condition the CLI:

1. loads the ignored frozen v0.3 input instead of rerunning static analysis;
2. verifies the code-range hash against the shared manifest;
3. verifies the fixed-contract hash using the L0 production targets;
4. rebuilds the offline prompt and compares it with the frozen prompt;
5. reconstructs the runtime resolver from preserved artifact descriptors and roots;
6. registers the frozen slices in the production `InMemoryCodeSliceRegistry`;
7. hashes the final request plus model/config/prompt/schema and implementation identifiers for resume/reuse;
8. verifies that Runner execution did not mutate the input.

Finding, Evidence, package context, schema, and prompt are not summarized. Allowed final-request differences from the preparation request are the configured model, `reasoning.effort`, and `max_output_tokens`.

## Execution and result states

The CLI separates dry-run validation, normal completion, completion without assessments/Evidence, additional-code need, Provider/Runner failure, timeout, output truncation, Evidence conversion partial/failure, input limit, and unknown-after-send.

Immediately before a live request it atomically writes `UNKNOWN_AFTER_SEND`. If the process terminates after transmission but before response persistence, resume will not automatically retry that condition. A completed result is reused only when its reuse key matches the exact request and experiment config. A different key in the same result location produces `RESULT_CONFIG_CONFLICT`; use a new output directory.

Conditions that are byte-identical retain their own row but set `sharedResultOf` and do not call the Provider again. `reasoningTokens` is recorded as a subset of `outputTokens` and is never added a second time.

Shared results contain hashes, counts, statuses, usage, timings, and validation summaries. Full request, API response, Agent output, validation, and Evidence conversion details are stored below ignored `private/`. Terminal output does not print source code, raw responses, or credentials.

## Commands

Dry-run the DD-NPM-010 smoke inputs:

```bash
cd apps/scanner
node --no-node-snapshot scripts/agent-code-volume-luna.mjs \
  --output experiments/agent-code-volume/<new-run> \
  --sample DD-NPM-010 \
  --level L0,L2 \
  --max-calls 2
```

Live smoke, using only the current process's `OPENAI_API_KEY`:

```bash
node --no-node-snapshot scripts/agent-code-volume-luna.mjs \
  --output experiments/agent-code-volume/<new-live-run> \
  --sample DD-NPM-010 \
  --level L0,L2 \
  --max-calls 2 \
  --live
```

API-free mock scenarios use `--mock completed-empty`, `completed-valid`, `additional`, `invalid`, `truncated`, or `provider-error`. `--mock` and `--live` are mutually exclusive.
`--max-output-tokens` and `--timeout-ms` are explicit experiment-only overrides; changing either changes the reuse key and requires a new result directory when an existing condition was already recorded.

Run the remaining unique conditions later by selecting sample IDs and levels explicitly. Adjacent SAME_INPUT conditions are linked automatically, but the original comparison rows remain in the run manifest.

```bash
node --no-node-snapshot scripts/agent-code-volume-luna.mjs \
  --output experiments/agent-code-volume/<new-full-run> \
  --sample DD-NPM-003,DD-NPM-010,DD-NPM-013,DD-NPM-015,DD-NPM-001 \
  --level L0,L1,L2,L3,L4 \
  --max-calls 22 \
  --live
```

That command is documentation only; this task does not execute the full 22 unique inputs.
