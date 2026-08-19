---
name: omc-orchestration
description: Improve ultracode, swarm, background, and subagent task management with dependency-aware waves, bounded parallelism, explicit model tiers, and evidence-backed handoff.
---

# Orchestration

For independent work, form a small task graph and launch a bounded wave. Keep each task file- or concern-scoped, state its acceptance criterion, and return summary, files touched, verification, and blockers. Run long tests/builds in the background and poll them instead of opening speculative workers.

On DeepSeek, route cheap background work to the Flash low tier, keep output caps tight, and avoid fan-out unless it removes real wall-clock time. Never make subagents race on the same files. Prefer Claude Code's native subagents; use external team CLIs only when installed and explicitly requested, and verify process output before reporting success.
