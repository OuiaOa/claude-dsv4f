---
name: dsv4shim-code-quality
description: Keep coding changes reliable with a cheap feedback loop. Load for implementation, refactoring, debugging, review, or before declaring a change complete; run the smallest relevant checks, then use deep-code-reviewer for risky lifecycle/concurrency changes and pre-push-verifier before publishing.
---

# dsv4shim quality workflow

Use this workflow for code changes. It is deliberately additive: Claude Code keeps its
normal planning, editing, tool loop, background tasks, and subagent behavior.

## During implementation

1. Identify the repository's real check commands before editing. Prefer the package's existing
   `check`, `typecheck`, `lint`, and focused test commands. Do not install dependencies or
   invent a new build system just to make a check pass.
2. Make the smallest coherent change. Preserve public behavior unless the task calls for a
   change, and keep model/provider adapters at the shim boundary.
3. After a meaningful edit, inspect the actual diff and run the narrowest check that covers it.
   The installed PostToolUse hook also runs local checks in the background after source edits;
   treat its result as evidence, not as a replacement for reading the diff.

## Review routing

- Load `deep-code-reviewer` when the change touches async work, background/subagent dispatch,
  queues, caching, subprocesses, setup/reroute, credentials, or public request/response shape.
- Load `lifecycle-auditor` for cleanup, cancellation, retries, process ownership, or concurrent
  work. Check that every permit, timer, stream, and child process has an independent release path.
- Load `simplification-hunter` after the behavior is correct, especially when adding defensive
  routing or compatibility branches.
- Load `cot-leakage-trimmer` for model-facing prompts, diagnostics, or generated prose. Do not
  apply prose rules mechanically to source code or technical documentation.
- Load `pre-push-verifier` before publishing. It chooses evidence from the outgoing diff and
  must report skipped live-provider checks honestly.

## Completion bar

Before claiming completion:

- inspect `git diff --check` and the complete changed files;
- run focused tests plus adjacent tests for shared contracts;
- exercise the shipped entry path when changing setup, CLI, routing, or hooks;
- test both the normal path and the failure/cleanup path for concurrency changes;
- keep credentials, sentinel files, usage journals, and generated local profiles out of commits.

The goal is high-signal evidence with bounded local work. Never turn this workflow into an
unbounded swarm or a second model loop.
