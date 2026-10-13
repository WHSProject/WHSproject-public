#!/usr/bin/env python3
"""Run selected PR CI checks locally.

This is a lightweight fallback for periods when GitHub Actions cannot start.
It mirrors the repository's PR CI commands by component without forcing every
developer to run the full workflow for every change.

Examples:
    python scripts/local-pr-ci.py gateway
    python scripts/local-pr-ci.py scanner --skip-install
    python scripts/local-pr-ci.py compose docker-scanner
    python scripts/local-pr-ci.py all --dry-run
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Step:
    name: str
    command: tuple[str, ...]
    cwd: Path = ROOT
    env: Mapping[str, str] | None = None
    install: bool = False


def q(command: Sequence[str]) -> str:
    return shlex.join(command)


def npm_steps(component: str, commands: list[tuple[str, tuple[str, ...]]]) -> list[Step]:
    cwd = ROOT / "apps" / component
    return [
        Step(name, command, cwd=cwd, install=(name == "Install dependencies"))
        for name, command in commands
    ]


TARGETS: dict[str, list[Step]] = {
    "dashboard": npm_steps(
        "dashboard",
        [
            ("Install dependencies", ("npm", "ci")),
            ("Lint", ("npm", "run", "lint")),
            ("Typecheck", ("npm", "run", "typecheck")),
            ("Test", ("npm", "test")),
            ("Build", ("npm", "run", "build")),
        ],
    ),
    "gateway": npm_steps(
        "gateway",
        [
            ("Install dependencies", ("npm", "ci")),
            ("Test", ("npm", "test", "--", "--runInBand")),
            ("Build", ("npm", "run", "build")),
        ],
    ),
    "scanner": [
        Step(
            "Activate pnpm 10.34.5",
            ("corepack", "prepare", "pnpm@10.34.5", "--activate"),
        ),
        Step(
            "Install dependencies",
            ("corepack", "pnpm", "install", "--filter", "scanner", "--frozen-lockfile"),
            install=True,
        ),
        Step(
            "Typecheck",
            ("corepack", "pnpm", "--filter", "scanner", "typecheck"),
        ),
        Step(
            "Test",
            ("corepack", "pnpm", "--filter", "scanner", "test"),
        ),
        Step(
            "Build",
            ("corepack", "pnpm", "--filter", "scanner", "build"),
        ),
        Step(
            "Agent experiment CLI",
            ("corepack", "pnpm", "--filter", "scanner", "test:agent-experiment:cli"),
            env={"OPENAI_API_KEY": "", "LLM_API_KEY": ""},
        ),
    ],
    "policy": [
        Step(
            "Install dependencies",
            (sys.executable, "-m", "pip", "install", "-r", "requirements.txt"),
            cwd=ROOT / "apps" / "policy",
            install=True,
        ),
        Step(
            "Test",
            (sys.executable, "-m", "pytest", "-q"),
            cwd=ROOT / "apps" / "policy",
        ),
    ],
    "compose": [
        Step(
            "Verdaccio approval plugin test",
            ("npm", "test"),
            cwd=ROOT / "infra" / "verdaccio" / "plugins" / "verdaccio-whs-approval",
        ),
        Step("Docker Compose config", ("docker", "compose", "config", "--quiet")),
    ],
    "integration": [
        Step(
            "Start Policy / Decision DB runtime",
            (
                "docker",
                "compose",
                "up",
                "-d",
                "--build",
                "--wait",
                "postgres",
                "policy-db-api",
                "decision-db-api",
                "policy",
            ),
            env={"POLICY_LLM_MODE": "fixture"},
        ),
        Step(
            "Policy / Decision DB integration smoke",
            (sys.executable, "tests/integration/policy_decision_db_smoke.py"),
            env={"POLICY_LLM_MODE": "fixture"},
        ),
    ],
    "docker-scanner": [
        Step(
            "Build Scanner runtime image",
            (
                "docker",
                "build",
                "--target",
                "runtime",
                "-t",
                "whs-local-ci-scanner",
                "-f",
                "apps/scanner/Dockerfile",
                ".",
            ),
        ),
        Step(
            "Verify Scanner Entrypoint",
            (
                "docker",
                "image",
                "inspect",
                "whs-local-ci-scanner",
                "--format",
                "{{json .Config.Entrypoint}}",
            ),
        ),
        Step(
            "Verify Scanner Cmd",
            (
                "docker",
                "image",
                "inspect",
                "whs-local-ci-scanner",
                "--format",
                "{{json .Config.Cmd}}",
            ),
        ),
    ],
    "docker-gateway": [
        Step(
            "Build Gateway image",
            (
                "docker",
                "build",
                "-t",
                "whs-local-ci-gateway",
                "-f",
                "apps/gateway/Dockerfile",
                "apps/gateway",
            ),
        )
    ],
    "docker-dashboard": [
        Step(
            "Build Dashboard image",
            (
                "docker",
                "build",
                "-t",
                "whs-local-ci-dashboard",
                "-f",
                "apps/dashboard/Dockerfile",
                "apps/dashboard",
            ),
        )
    ],
    "docker-policy": [
        Step(
            "Build Policy image",
            (
                "docker",
                "build",
                "-t",
                "whs-local-ci-policy",
                "-f",
                "apps/policy/Dockerfile",
                ".",
            ),
        )
    ],
}

ALL_TARGETS = (
    "dashboard",
    "gateway",
    "scanner",
    "policy",
    "compose",
    "integration",
    "docker-scanner",
    "docker-gateway",
    "docker-dashboard",
    "docker-policy",
)


def run_step(
    step: Step, *, dry_run: bool
) -> tuple[bool, float, str | None, str | None]:
    display_cwd = step.cwd.relative_to(ROOT) if step.cwd != ROOT else Path(".")
    print(f"\n  -> {step.name}")
    print(f"     cwd: {display_cwd}")
    print(f"     $ {q(step.command)}")

    if dry_run:
        return True, 0.0, None, None

    env = os.environ.copy()
    if step.env:
        env.update(step.env)

    started = time.monotonic()

    command: Sequence[str] | str = step.command
    use_shell = False

    if os.name == "nt":
        executable = shutil.which(step.command[0])

        if executable is None:
            return (
                False,
                time.monotonic() - started,
                f"command not found: {step.command[0]}",
                None,
            )

        resolved_command = (executable, *step.command[1:])

        if Path(executable).suffix.lower() in {".cmd", ".bat"}:
            command = subprocess.list2cmdline(resolved_command)
            use_shell = True
        else:
            command = resolved_command

    try:
        result = subprocess.run(
            command,
            cwd=step.cwd,
            env=env,
            text=True,
            capture_output=step.name.startswith("Verify Scanner"),
            check=False,
            shell=use_shell,
        )
    except FileNotFoundError as exc:
        return (
            False,
            time.monotonic() - started,
            f"command not found: {exc.filename}",
            None,
        )

    elapsed = time.monotonic() - started
    output = result.stdout.strip() if result.stdout else None
    if result.returncode != 0:
        if result.stderr:
            print(result.stderr.rstrip())
        return False, elapsed, f"exit code {result.returncode}", output
    return True, elapsed, None, output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run selected WHSProject PR CI checks locally.",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "targets",
        nargs="+",
        choices=(*ALL_TARGETS, "all"),
        help="CI target(s) to run. Use 'all' for every target.",
    )
    parser.add_argument(
        "--skip-install",
        action="store_true",
        help="Skip npm/pnpm/pip dependency installation steps.",
    )
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="Continue with remaining targets after a failure.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print commands without executing them.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    requested: list[str] = []
    for target in args.targets:
        expanded = ALL_TARGETS if target == "all" else (target,)
        for name in expanded:
            if name not in requested:
                requested.append(name)

    print("[local-pr-ci] repository:", ROOT)
    print("[local-pr-ci] targets:", ", ".join(requested))
    if args.skip_install:
        print("[local-pr-ci] dependency install steps: SKIPPED")
    if args.dry_run:
        print("[local-pr-ci] mode: DRY RUN")

    results: list[tuple[str, bool, float, str | None]] = []
    overall_ok = True

    for target in requested:
        print(f"\n=== {target} ===")
        target_ok = True
        target_started = time.monotonic()
        error: str | None = None

        for step in TARGETS[target]:
            if args.skip_install and step.install:
                print(f"\n  -> {step.name}: SKIP (--skip-install)")
                continue

            ok, elapsed, step_error, output = run_step(step, dry_run=args.dry_run)

            if target == "docker-scanner" and ok and not args.dry_run:
                if (
                    step.name == "Verify Scanner Entrypoint"
                    and output != '["docker-entrypoint.sh"]'
                ):
                    ok = False
                    step_error = f"unexpected Entrypoint: {output}"
                elif (
                    step.name == "Verify Scanner Cmd"
                    and output != '["pnpm","--filter","scanner","start"]'
                ):
                    ok = False
                    step_error = f"unexpected Cmd: {output}"

            status = "PASS" if ok else "FAIL"
            print(f"     [{status}] {elapsed:.1f}s")

            if not ok:
                target_ok = False
                error = f"{step.name}: {step_error or 'failed'}"
                print(f"     [ERROR] {error}")
                break

        total = time.monotonic() - target_started
        results.append((target, target_ok, total, error))
        overall_ok = overall_ok and target_ok

        if not target_ok and not args.keep_going:
            break

    print("\n=== Local PR CI Summary ===")
    for target, ok, elapsed, error in results:
        detail = f" - {error}" if error else ""
        print(
            f"{'PASS' if ok else 'FAIL':4}  "
            f"{target:18} {elapsed:7.1f}s{detail}"
        )

    if len(results) != len(requested):
        skipped = requested[len(results):]
        print("SKIP  remaining targets:", ", ".join(skipped))

    if args.dry_run:
        print("\n[local-pr-ci] dry-run only; no validation was executed.")
    elif overall_ok and len(results) == len(requested):
        print("\n[local-pr-ci] PASS selected local checks.")
    else:
        print("\n[local-pr-ci] FAIL. Review the first failing step above.")

    return 0 if overall_ok and len(results) == len(requested) else 1


if __name__ == "__main__":
    raise SystemExit(main())
