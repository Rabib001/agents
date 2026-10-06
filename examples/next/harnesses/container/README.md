# Next: an agent CLI in a Container

An early-access, server-only example of `ContainerHarness` from
`agents/harness/container`: Claude Code or Codex runs in a Cloudflare
Container, and a plain Durable Object drives it with the same interface as
`PiHarness`. There is no Dockerfile, and no credentials enter the container.

```ts
import { ContainerHarness, claudeCode } from "agents/harness/container";

// Adds the credentials outside the container; export it from the main module.
export { ContainerEgress } from "agents/harness/container";

export class CodingAgent extends DurableObject<Env> {
  readonly harness = new ContainerHarness({
    container: this.ctx.container,
    egress: this.ctx.exports.ContainerEgress,
    agent: claudeCode({
      access: {
        gateway: {
          url: this.env.AI_GATEWAY_URL,
          token: this.env.AI_GATEWAY_TOKEN
        }
      }
    })
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);
}

// anywhere in the object:
const { text } = await this.harness.prompt("Add a test for parse()");
```

`codex()` with the gateway's `/openai` base URL runs Codex instead.
Nothing else changes. Leave out `baseUrl` to call the provider directly with
its own key, and add `headers` for anything else a request needs (gateway
metadata, or `cf-aig-authorization` for a BYOK gateway).

```jsonc
// wrangler.jsonc
"containers": [
  { "class_name": "CodingAgent", "scheduling_policy": "durable_object" }
]
```

## What happens

- **First start.** The harness starts `cloudflare/debian-trixie`, uses
  `exec()` to create an unprivileged `agent` user and install the CLI
  (`npm install -g @anthropic-ai/claude-code`), writes its bundled daemon
  into the container, and snapshots the filesystem. Later starts restore the
  snapshot and are ready in a few seconds. Changing the preset (a new CLI
  version, extra `setup` steps) sets up afresh.
- **Each turn** is one CLI process run as `agent`: `claude -p
--output-format stream-json` or `codex exec --json`. The daemon turns its
  output into the harness's messages and events, and mirrors the CLI's
  session files (`~/.claude/projects`, `~/.codex/sessions`) to the object as
  the turn runs.
- **Credentials.** The CLI is pointed at a placeholder host
  (`http://anthropic.harness.internal`) with a placeholder key. The harness
  intercepts that host with `ctx.container.interceptOutboundHttp()`, and
  `ContainerEgress`, running in your Worker, swaps in the real credentials
  and forwards to `baseUrl`. `env` in the container shows only the
  placeholder.
- **Recovery.** The container stops five minutes after the last prompt
  (`idleTimeoutMs`). The next prompt starts a new one from the snapshot,
  restores the session files, and the CLI resumes its own session. If the
  container dies mid-run, that run settles `unanswered` with
  `container_lost` and the session continues. If the object is evicted
  mid-run, the container keeps working; the object reattaches and replays
  what it missed.

## Another CLI

Build an image whose entrypoint serves the daemon with `cliAdapter`, and use
`containerAgent({ image: ctx.container.images.agent, adapter: "my-agent" })`:

```ts
import { cliAdapter, serveFromEnv } from "agents/harness/container/runtime";

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
pnpm run dev                                # Claude Code
pnpm run dev -- --var HARNESS_AGENT:codex   # Codex
pnpm run dev -- --var HARNESS_AGENT:echo    # no model, no credentials
```

With [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
the gateway token is the only credential, and it never leaves the object.

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
