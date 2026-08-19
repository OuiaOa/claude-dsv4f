---
name: agent-reach
description: Use source-aware internet access for GitHub, YouTube, RSS, Reddit, X/Twitter, Bilibili, LinkedIn and other supported platforms. Prefer it for platform research, search, transcripts, and current facts.
---

# Agent Reach

Check `agent-reach doctor` first. When installed, use the platform-specific command it reports as healthy and preserve source URLs in the answer.

Ordinary webpage: `dsv4shim web <url>`. GitHub: `gh repo view`/`gh search` or the Agent Reach GitHub path. YouTube: `yt-dlp`/Agent Reach transcript path. RSS: feed parser. Logged-in platforms require credentials or a browser session explicitly configured by the user; never automate login or request cookies in chat.

The skill may guide setup but must not silently install system packages, upload credentials, or claim a channel is available without `agent-reach doctor` evidence.
