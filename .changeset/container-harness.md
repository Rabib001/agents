---
"agents": minor
---

Add experimental `agents/harness/container`: `ContainerHarness` runs an agent CLI such as Claude Code or Codex in a Cloudflare Container (`ctx.container`) and drives it from a Durable Object, with the same interface as `PiHarness` (`prompt`, `submit`, `wait`, `abort`, `messages`, `pending`, `session(id)`, `sessions`). The container stops after an idle timeout (five minutes by default) and the next prompt starts a new one that resumes the session from state the adapter persisted in the object; a container lost mid-run settles that run as `container_lost` (or reruns it with `onContainerLost: "retry"`), and an object evicted mid-run reattaches and replays what it missed. The process inside the container is built on `agents/harness/container/daemon`, a runtime-agnostic daemon core with an adapter interface, and the sessions, operations and history live in `agents/harness/store`, a session store on the object's SQLite that any harness can use.
