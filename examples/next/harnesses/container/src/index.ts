import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import {
  ContainerHarness,
  claudeCode,
  codex,
  echoAgent,
  type ContainerAgent
} from "agents/harness/container";
import { Lifecycle } from "agents/lifecycle";

// The harness adds credentials outside the container through this
// entrypoint; it must be exported from the main module.
export { ContainerEgress } from "agents/harness/container";

/**
 * One coding agent per object: Claude Code or Codex (picked by
 * `HARNESS_AGENT`) runs in this object's container, and `ContainerHarness`
 * drives it with the same interface as `PiHarness`.
 *
 * There is no image to build: the harness sets the container up from
 * `cloudflare/debian-trixie` on first use and snapshots it. The object
 * keeps everything durable (sessions, operations, the transcript, the
 * CLI's own session files) and the container is disposable: it stops five
 * minutes after the last prompt, and the next prompt starts a new one in
 * which the CLI resumes its session. The AI Gateway token stays in the
 * object; the container only ever sees a placeholder.
 */
export class CodingAgent extends DurableObject<Env> {
  readonly harness = new ContainerHarness({
    container: containerOf(this.ctx),
    agent: agentFor(this.env),
    egress: this.ctx.exports.ContainerEgress,
    instance: "standard-2"
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.split("/").slice(4).join("/");
    const session = this.harness.session(
      url.searchParams.get("session") ?? undefined
    );

    if (request.method === "POST" && route === "prompt") {
      const body = await request.json<{ text?: string; wait?: boolean }>();
      if (!body.text) return new Response("text is required", { status: 400 });
      if (body.wait) return Response.json(await session.prompt(body.text));
      return Response.json(await session.submit(body.text), { status: 202 });
    }
    const waitMatch = /^operations\/([^/]+)$/.exec(route);
    if (request.method === "GET" && waitMatch?.[1]) {
      return Response.json(
        await session.wait(decodeURIComponent(waitMatch[1]), request.signal)
      );
    }
    if (request.method === "GET" && route === "messages") {
      return Response.json(await session.messages());
    }
    if (request.method === "GET" && route === "events") {
      return this.#events(session.id, request.signal);
    }
    if (request.method === "POST" && route === "abort") {
      return Response.json({ aborted: await session.abort() });
    }
    if (request.method === "POST" && route === "sessions") {
      return Response.json({ id: (await this.harness.sessions.create()).id });
    }
    if (request.method === "POST" && route === "stop") {
      // Stop the container now, to see the next prompt resume the session
      // in a new one.
      await this.harness.stop();
      return Response.json({ stopped: true });
    }
    return Response.json({
      container: await this.harness.container(),
      sessions: await this.harness.sessions.list(),
      pending: await this.harness.pending()
    });
  }

  /** A session's events over SSE: the snapshot, then live events. */
  async #events(session: string, signal: AbortSignal): Promise<Response> {
    const stream = await this.harness.session(session).events();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        send("snapshot", stream.snapshot);
        stream.start((events) => {
          for (const event of events) send(event.type, event);
        });
        signal.addEventListener("abort", () => {
          void stream.stop();
          controller.close();
        });
      }
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" }
    });
  }
}

/** The agent `HARNESS_AGENT` names, reaching its provider through AI Gateway. */
function agentFor(env: Env): ContainerAgent {
  // With Unified Billing the gateway takes its own token as the key.
  const key = env.AI_GATEWAY_TOKEN;
  const name: string = env.HARNESS_AGENT;
  switch (name) {
    case "codex":
      return codex({ baseUrl: `${env.AI_GATEWAY_URL}/openai`, apiKey: key });
    case "echo":
      return echoAgent();
    default:
      return claudeCode({
        baseUrl: `${env.AI_GATEWAY_URL}/anthropic`,
        apiKey: key
      });
  }
}

function containerOf(ctx: DurableObjectState): Container {
  if (!ctx.container) {
    throw new Error("CodingAgent needs a container: see wrangler.jsonc");
  }
  return ctx.container;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
