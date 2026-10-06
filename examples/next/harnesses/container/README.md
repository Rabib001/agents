# Next: an agent CLI in a Container

An early-access, server-only example of `ContainerHarness` from
`agents/harness/container`: Claude Code or Codex runs in a Cloudflare
Container, and a plain Durable Object drives it with the same interface as
`PiHarness`.

```ts
export class CodingAgent extends DurableObject<Env> {
  readonly harness = new ContainerHarness({
    container: this.ctx.container,
    launch: {
      image: this.ctx.container.images.agent,
      instance: "standard-2",
      enableInternet: true,
      env: {
        CF_HARNESS_ADAPTER: "codex", // or "claude-code"
        OPENAI_BASE_URL: `${this.env.AI_GATEWAY_URL}/openai`,
        OPENAI_API_KEY: this.env.AI_GATEWAY_TOKEN
      }
    },
    defaults: { model: "gpt-5.1" }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);
}

// anywhere in the object:
const { text } = await this.harness.prompt("Add a test for parse()");
```

Switching CLIs changes the adapter name, the model, and the credentials.
Nothing else in the object changes.

## What runs where

- **The Durable Object** owns everything durable, in a `HarnessStore`
  (`agents/harness/store`): sessions, operations, the transcript, and the
  CLI's own session files.
- **The container** runs `@cloudflare/harness-daemon` (`container/Dockerfile`).
  Each turn is one CLI process: `claude -p --output-format stream-json` or
  `codex exec --json`. The daemon turns the CLI's output into the harness's
  messages and events, and mirrors the CLI's session directory
  (`~/.claude/projects`, `~/.codex/sessions`) to the object as the turn runs.

The container is disposable. It starts on the first prompt and stops five
minutes after the last one (`idleTimeoutMs`). The next prompt starts a new
container, restores the session files, and the CLI resumes its own session
(`--resume`, `codex exec resume`). If the container dies mid-run, that run
settles `unanswered` with `container_lost`, queued prompts run in the
replacement, and the session continues. If the object is evicted mid-run,
the container keeps working; the object's wake job reattaches and replays
what it missed.

## Another CLI

Any CLI that runs one turn per process and prints JSON lines fits. Write an
entrypoint with `cliAdapter` and build it into the image instead of the
bundled `main.ts`:

```ts
import { serveFromEnv } from "@cloudflare/harness-daemon";
import { cliAdapter } from "@cloudflare/harness-daemon/cli";

await serveFromEnv(
  cliAdapter({
    id: "my-agent",
    stateDirs: [".my-agent/sessions"],
    command: (turn) => ({
      argv: [
        "my-agent",
        "--json",
        ...(turn.state.id ? ["--resume", turn.state.id] : [])
      ],
      stdin: turn.prompt
    }),
    parser: () => ({
      line: (text) => myAgentLine(JSON.parse(text)), // events, state, outcome
      end: ({ code }) => ({ status: "unanswered", reason: `exit ${code}` })
    })
  })
);
```

## Run

Containers need Docker locally. Set `AI_GATEWAY_URL` in `wrangler.jsonc` and
put an AI Gateway token in `.dev.vars`:

```sh
echo "AI_GATEWAY_TOKEN=..." > .dev.vars
pnpm install
pnpm run dev                                  # Claude Code
pnpm run dev -- --var HARNESS_ADAPTER:codex   # Codex
pnpm run dev -- --var HARNESS_ADAPTER:echo    # no model, no credentials
```

With [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
the gateway token is the only credential: no Anthropic or OpenAI key enters
the container. The container can still read the gateway token, and the CLI's
tools run arbitrary commands, so scope the token to this use.

Exercise the agent named `demo`:

```sh
B=http://localhost:8787/agents/coding-agent/demo

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
