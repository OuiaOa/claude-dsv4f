---
name: defuddle
description: Read ordinary web pages as clean, low-noise Markdown. Use for any http(s) article, documentation page, blog post, product page, or online reference request; skip URLs that are already raw Markdown or JSON.
---

# Defuddle web reading

For a normal webpage, run `dsv4shim web <url>` before reasoning over it. This calls the Defuddle CLI when installed and otherwise uses the clean-reader fallback. Prefer the returned Markdown over browser chrome, navigation, ads, cookie banners, and repeated footers.

Use the original URL as the citation/source. If the reader fails, report that clearly and try the next available source; never silently substitute a search snippet for the page.

Do not use this for `.md`, `.json`, source files, authenticated private pages, or pages where the user explicitly asks for rendered/visual inspection. Optional install: `npm install -g defuddle`; do not install it automatically during an unrelated task.
