---
name: mission-control
description: Use the Mission Control/Hermy HQ concepts for planning, approvals, memory, and observable long-running work when a local Hermes mission-control deployment is present or explicitly requested.
---

# Mission Control

Mission Control is an optional self-hosted dashboard/message-bus companion, not a hidden dependency of the shim. If a configured Hermes endpoint or project is present, use it to expose plan state, approvals, side effects, and progress. Otherwise keep state in Claude Code's normal goal/session mechanisms and do not deploy Postgres or a web app automatically.

Before any external side effect, show the intended action and wait for approval. Treat dashboard state as coordination metadata, not proof that a task or deployment succeeded.
