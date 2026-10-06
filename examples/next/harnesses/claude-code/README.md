# Next: Claude Code in a Container

An early-access, server-only example of `ContainerHarness` from
`agents/harness/container`: Claude Code runs in a Cloudflare Container, and a
plain Durable Object drives it with the same interface as `PiHarness`.

```ts
export class ClaudeCodeAgent extends DurableObject<Env> {
  readonly harness = new ContainerHarness({
    container: this.ctx.container,
    launch: {
      image: this.ctx.container.images.agent,
      instance: "standard-2",
      enableInternet: true,
      env: { ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY }
    },
    defaults: { model: "claude-sonnet-4-5" }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);
}

// anywhere in the object:
const { text } = await this.harness.prompt("Add a test for parse()");
```

## What runs where

- **The Durable Object** owns everything durable, in a `HarnessStore`
  (`agents/harness/store`): sessions, operations, the transcript, and Claude
  Code's own session mirror.
- **The container** runs `@cloudflare/harness-daemon` (`container/Dockerfile`)
  with its Claude Code adapter: one Agent SDK `query()` per session, whose
  `SessionStore` mirrors every transcript batch back to the object.

The container is disposable. It starts on the first prompt, stops five minutes
after the last one (`idleTimeoutMs`), and the next prompt starts a new one in
which the adapter resumes the same Claude Code session from the mirror. If the
container dies mid-run, the run settles `unanswered` with `container_lost`,
queued prompts run in the replacement, and the session continues. If the
object is evicted mid-run, the container keeps working; the object's wake job
reattaches and replays what it missed.

## Run

Containers need Docker locally.

```sh
pnpm install
# Keyless: the echo adapter exercises the whole path without a model.
pnpm run dev -- --var HARNESS_ADAPTER:echo
```

For Claude Code, put `ANTHROPIC_API_KEY` in `.dev.vars` (or route through AI
Gateway with `ANTHROPIC_BASE_URL` in `wrangler.jsonc`) and run `pnpm run dev`.

Exercise the agent named `demo`:

```sh
B=http://localhost:8787/agents/claude-code-agent/demo

# Prompt and wait for the answer.
curl -X POST $B/prompt -H "content-type: application/json" \
  -d '{"text": "Create hello.txt containing hi", "wait": true}'

# Or submit, watch events over SSE, and wait for one operation.
curl -X POST $B/prompt -H "content-type: application/json" -d '{"text": "ls"}'
curl -N $B/events
curl $B/operations/<operationId>

# Stop the container, then prompt again: a new container resumes the session.
curl -X POST $B/stop

curl $B/messages
curl $B/            # container, sessions, pending operations
```

Add `?session=<id>` to address a session other than the root; `POST
$B/sessions` creates one.

## Credentials

The container receives `ANTHROPIC_API_KEY` in its environment, and Claude
Code's tools run arbitrary commands in that container. Prefer an AI Gateway
token scoped to this use, and treat the container as able to read it.
