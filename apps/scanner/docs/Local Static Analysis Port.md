# Local Static Analysis Port

`LocalStaticAnalysisService` is an application-only port for explicitly supplied,
already-extracted npm packages. It is not registered as an HTTP controller and does
not change `Orchestrator.execute()`.

The caller must provide a request-scoped `allowedArtifactRoot` and an integrity
verifier backed by a trusted manifest or archive hash. Both the root and package
directory are resolved with `realpath`; broad roots, escapes, missing directories,
files, and symlink escapes are rejected.

The application treats the package tree as read-only. Metadata analysis is in-process.
External analyzers are only eligible when their execution boundary is separately
verified. The service hashes the complete package tree before and after analysis and
fails on any mutation. This detects writes but is not an OS permission boundary. A
real GuardDog external-artifact run additionally requires a verified network-none
wrapper whose filesystem mount is read-only. Without that wrapper GuardDog fails
closed before spawn.

The approved backend is `DockerExternalGuardDogRunner`. It requires an exact image
digest and verifies the Docker daemon, arm64/amd64 compatibility, a non-root image
user, network-none diagnostics, a read-only package mount, a read-only rootfs, a
bounded writable tmpfs, and secret-environment absence before reporting
`VERIFIED_NETWORK_NONE`. Runtime limits include all-capability drop,
`no-new-privileges`, PID/memory/CPU bounds, and no host namespace or Docker socket
mount. The production Scanner container stage and `Orchestrator` remain unchanged.

GuardDog receives only `PATH`, temporary-directory variables, and locale variables.
Secrets and the rest of `process.env` are not inherited. GuardDog 3.1.0 has no
confirmed offline/cache-disable CLI option in this repository; the documented cache
lookups mean its own sandbox alone is not accepted as network isolation.

Semgrep is never installed by this port. Availability distinguishes executable
absence, version-check failure, unwritable runtime configuration, missing ruleset,
timeout, and a non-zero analysis exit. The approved image contains Semgrep 1.172.0;
the original smoke failed because its default `/.semgrep/settings.yml` was unwritable,
so that historical result is `UNAVAILABLE / SEMGREP_RUNTIME_CONFIG_UNWRITABLE`, not
`SEMGREP_EXECUTABLE_NOT_FOUND`. A synthetic-only diagnostic confirmed that
`SEMGREP_SETTINGS_FILE`, `HOME`, and XDG config/cache locations can be placed under
the bounded `/tmp`, with `--disable-version-check --metrics off`, while keeping the
rootfs and fixture mount read-only and the network disabled. P0 results are not
substituted for Semgrep.

`DockerExternalCustomRuleRunner` provides the external-only runner while the
operational `CustomRuleAnalyzer` default spawn path remains unchanged. It reuses the
same digest-pinned image and security controls as external GuardDog, maps only the
read-only package root, and reads the existing ruleset embedded in the image at
`/app/apps/scanner/rules/custom-rule-analyzer.yml`. Preflight verifies Semgrep
1.172.0, the ruleset SHA-256, bounded `/tmp` writes, package write denial, DNS/TCP
denial, non-root identity, and absence of host credentials. Container and host paths
are normalized before the existing parser and Finding mapper.

The bounded Custom Rule-only Dataset smoke is recorded separately in
`local-static-custom-rule-smoke.v1.json`; it does not rewrite the earlier four-sample
GuardDog/Metadata execution history.

## Smoke invocation budget

The smoke harness has four explicit phases: `select`, `preflight`, `seal-manifest`,
and `execute`. Selection and preflight have no analyzer dependency. Execution
requires both an immutable sealed manifest and an atomic invocation reservation.
The JSON ledger is guarded by an exclusive lock file and replaced by same-directory
atomic rename. A reservation is committed before analyzer entry, so failed attempts
consume budget; retry zero, duplicate analyzer calls, unapproved samples, a fourth
unique sample, and backend-attestation mismatches fail closed. Mock calls require a
`TEST_DOUBLE` attestation and do not consume the real-call ledger.

The historical four-sample incident is retained in
`local-static-smoke-history.v1.json`. `FIXED_NOT_REEXECUTED` means that the previous
limit violation remains recorded and prevention was verified with mocks/synthetic
fixtures; it does not claim that the original execution was compliant. No Dataset
analyzer was rerun to reach this status.
