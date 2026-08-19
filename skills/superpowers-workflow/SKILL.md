---
name: superpowers-workflow
description: Apply a disciplined software-development workflow to non-trivial coding tasks: clarify, plan, test, implement, debug from evidence, review, and verify before completion.
---

# Coding workflow

For a non-trivial change: restate acceptance criteria briefly, inspect the implementation, make a small dependency-aware plan, add a focused regression test when practical, implement the smallest coherent change, debug from the first causal failure, inspect the diff, and run relevant checks before claiming completion.

Use the existing dsv4shim quality gate and agents as the final review path. Preserve Claude Code's native loops, goals, and DeepSeek routing; this adapts the portable Superpowers methodology rather than replacing the runtime.
