---
"@cloudflare/think": patch
"agents": patch
---

A stored file part with a relative `url` (e.g. `/api/files/abc`) no longer fails every later turn of a Think chat with `Invalid URL`. AI SDK v7's `convertToModelMessages` can't parse such a url, so the model now gets a text reference in its place, like `[attachment notes.txt (text/plain) at /api/files/abc]`. The stored message and what clients see don't change, and file parts with absolute or `data:` URLs still reach the model as files. `ThinkHarness` does the same.
