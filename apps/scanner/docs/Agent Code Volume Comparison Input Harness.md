# Agent code-volume comparison input harness

## Purpose and boundary

`scripts/agent-code-volume-input.mjs` prepares controlled Tier 3 inputs for comparing how much code is supplied to the malware-analysis Agent. It fixes Findings, Atomic Evidence, package context, artifact descriptors, bindings, limitations, analysis targets, prompt/schema settings, and changes only initial code slices plus the targets needed to reference those slices.

Frozen Provider requests use the same `AGENT_OUTPUT_API_SCHEMA_V0_2` transport schema as the production Tier 3 v0.3 Runner. The internal `AGENT_OUTPUT_SCHEMA_V0_2` discriminated union remains the prompt/parser/Validator contract and is not mutated. Regenerate into a new input directory whenever the transport schema changes because the frozen request and request hashes change.

The harness is offline by default and has no Provider or Runner dependency. It removes API-key variables from its process, sets Tier 2 GPT to `off`, serializes the final Provider request without sending it, and records zero LLM calls. It does not download, install, import, or execute a package or lifecycle script. Static reruns use the existing Docker external analyzers with `--network none`, a read-only package mount, and a preflight that must succeed.

This prepares model inputs; it does not measure detection quality.

## Sources and preparation

The source manifest is `guarddog-pilot-selection/guarddog-pilot-samples.json`. Archive SHA-256, package name/version, and the extracted `package.json` are checked before preparation.

| Sample | Preparation | Static result version |
| --- | --- | --- |
| DD-NPM-003 | Reuse complete Planning snapshot | pilot-v2, Scanner `e766f2e...`, GuardDog 3.1.0, Semgrep 1.172.0, rules `969bb8...` |
| DD-NPM-010 | Reuse complete Planning snapshot | same pilot-v2 baseline |
| DD-NPM-013 | Reuse complete Planning snapshot | same pilot-v2 baseline |
| DD-NPM-015 | Rerun Tier 1, Tier 2 restore/derived analysis, and Normalizer | current Scanner commit recorded in the manifest; same GuardDog/Semgrep/rules versions |
| DD-NPM-001 | Rerun Tier 1, Tier 2 restore/derived analysis, and Normalizer | current Scanner commit recorded in the manifest; same GuardDog/Semgrep/rules versions |

The pilot-v2 restored runtime paths were cleaned. They are therefore not reused. DD-NPM-001 and DD-NPM-015 preserve their newly generated restored trees under the ignored `private/` experiment directory. Their new derived Findings and new NormalizationResult are kept together; old derived Findings are never paired with new restored code.

Pilot-v2 reports filter 0.1.0 at capture time. The reference filter result in the generated manifest is recalculated by the current 0.4.0 pure filter and does not control input generation.

## Fixed input and neutralization

The harness reuses these production components:

- `buildPlanningTier3ExecutionInput()` for Planning-to-Tier-3 projection and artifact binding;
- `AgentInputV0_3Builder` for the production L0 input;
- `RuntimeArtifactResolver` through `Tier3ExecutionInput.artifacts` for safe reads and root-boundary checks;
- `registerCodeSlice()` and `validateAgentAnalysisInputV0_3()` for hashes, lineage, references, and schema validation;
- `buildAgentPromptV0_2()` and `AGENT_OUTPUT_SCHEMA_V0_2` for the serialized Provider request.

DD sample IDs and pilot request/scan IDs are replaced once with neutral experiment IDs. Evidence IDs and evidence provenance scan IDs are changed consistently. Package identity, Finding IDs, Evidence contents, and source semantics remain unchanged. Ground truth and manual review files are never read by the harness.

For every level, a fixed-contract hash is calculated after removing `initialCodeSlices` and restoring the original production targets. A mismatch fails the sample. Original and deobfuscated code remain separate by `artifactId`; derived Findings are not rebound to original code and relation IDs are not repaired.

## Code levels

| Level | Included code |
| --- | --- |
| L0 | Exact initial slices produced by the current production v0.3 Builder and production slice budgets. Jev/context expansion is not run. |
| L1 | L0 plus the smallest complete containing function, or complete statement when no function contains the Finding; scope-resolved direct declarations/import declarations in the same file are also included. Parse/read failures become limitations. |
| L2 | L1 plus every complete file that has a bound Finding. |
| L3 | L2 plus package-local static `import`, `export ... from`, `require()`, and dynamic import string-literal edges to depth 2. Manifest entry points and lifecycle commands seed the same traversal. Selection is mechanical and does not consult ground truth. Resolution stays inside the same representation/artifact. |
| L4 | L3 plus all regular JS/TS-family files in each registered artifact. `node_modules`, `.git`, source maps, symlinks, and non-regular files are excluded. A `.sh` or `.py` file is supported only when directly named by an entry/lifecycle seed; other non-JS/TS files are reported as unsupported rather than silently skipped. |

Ranges are merged and de-duplicated. Each level must cover every previous range. A whole-file slice is not silently clipped to the production line budget. The default experiment read ceiling is 12 MiB per file; an unreadable/oversized file is a limitation, not a partial “whole file.” Single-line minified files are recorded with their actual bytes and line count.

The default serialized-request ceiling is 4 MiB. A larger level is retained but marked `INPUT_LIMIT_EXCEEDED`; it must not be described as a complete model-ready input. Identical code-range hashes across adjacent levels are marked `SAME_INPUT` through `sameInputAsPrevious` so a paid run can skip duplicates.

## Additional-code request control

All generated inputs set `maxToolCalls` and `maxAdditionalCodeRequests` to zero and mark every tool unavailable. The prompt uses the experiment-only `additionalCodeRequests: 'DISABLED'` option and directs the model to return limitations/missing context instead of `NEEDS_ADDITIONAL_CODE`. Production callers omit the option and retain their previous behavior.

Jev and context-check expansion are not called. Each L0-L4 request is independent and has no previous model response or tool response.

## Artifacts and privacy

Shared files under `experiments/agent-code-volume/2026-10-04-input-v1/` contain package provenance, hashes, relative file/range metadata, byte/line counts, estimated tokens, limitations, and validation results. Code bodies, full Planning inputs, restored trees, and serialized Provider requests are stored only below ignored `private/`.

Provider requests are checked for repository absolute paths, DD sample identifiers, and ground-truth labels. Shared output and logs do not contain code bodies or token-like strings. Estimated tokens are `ceil(JSON character count / 4)` and are not API usage or an exact tokenizer result.

## Reproduction

Build current Scanner code first:

```bash
cd apps/scanner
npm run build
node --no-node-snapshot scripts/agent-code-volume-input.mjs \
  --output experiments/agent-code-volume/2026-10-04-input-v1 \
  --offline-code-volume-inputs
```

The first command requires working Docker access for the two static rerun samples. It performs no model call. To rebuild inputs from frozen local results without static analysis:

```bash
node --no-node-snapshot scripts/agent-code-volume-input.mjs \
  --output experiments/agent-code-volume/2026-10-04-input-v1 \
  --offline-code-volume-inputs \
  --reuse-frozen
```

`--max-provider-request-bytes` and `--max-code-file-bytes` may set explicit experimental ceilings. Changing either changes the experiment configuration and must be recorded when comparing paid runs.

Before a paid experiment, choose one model, effort, output budget, and timeout, retain the frozen request JSON, skip adjacent `SAME_INPUT` levels, and invoke requests independently. The harness itself intentionally has no flag that sends requests.
