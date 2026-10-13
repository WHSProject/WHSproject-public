# Code-volume input preparation v1

This directory contains shared, code-free manifests produced by `scripts/agent-code-volume-input.mjs`.

- `manifest.json`: run configuration and all five sample summaries.
- `samples/sample-*.json`: per-sample code ranges, hashes, sizes, limitations, and validation results.
- `private/`: ignored local inputs, code bodies, restored artifacts, and serialized dry-run Provider requests.

No LLM call was made. Token counts are character/4 estimates. See `docs/Agent Code Volume Comparison Input Harness.md` for the design and reproduction commands.
