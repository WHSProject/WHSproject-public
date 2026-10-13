# DD-NPM-010 Luna smoke preparation

This run contains API-free validation for DD-NPM-010 L0 and L2.

- Model/config: `gpt-5.6-luna`, medium reasoning, 32,768 max output tokens, 180-second timeout, zero retries.
- Provider calls: 0.
- Live smoke: not executed because `OPENAI_API_KEY` was not configured in the current process.
- `LLM_API_KEY` was not treated as an alias; the experiment contract explicitly requires `OPENAI_API_KEY`.

`run.json` is code-free and shareable. Full live requests/responses would be stored below ignored `private/`.
