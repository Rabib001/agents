import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { ContainerHarness } from "agents/harness/container";
import { Lifecycle } from "agents/lifecycle";

/**
 * One coding agent per object: Claude Code runs in this object's container,
 * and `ContainerHarness` drives it with the same interface as `PiHarness`.
 *
 * The object keeps everything durable (sessions, operations, the
 * transcript, and Claude Code's own session mirror). The container is
 * disposable: it starts on the first prompt, stops five minutes after the
 * last one, and the next prompt starts a new one that resumes the Claude
 * Code session where it left off.
 */
export class ClaudeCodeAgent extends DurableObject<Env> {
  readonly harness = new ContainerHarness({
    container: containerOf(this.ctx),
    launch: {
      image: imageOf(this.ctx, "agent"),
      instance: "standard-2",
      enableInternet: true,
      env: launchEnv(this.env)
    },
    defaults: {
      model: "claude-sonnet-4-5",
      options: { appendSystemPrompt: "Work in /workspace." }
    }
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

/** The container's environment: the adapter, and Claude Code's credentials. */
function launchEnv(env: Env): Record<string, string> {
  const launch: Record<string, string> = {
    CF_HARNESS_ADAPTER: env.HARNESS_ADAPTER,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? ""
  };
  const baseUrl: string = env.ANTHROPIC_BASE_URL;
  if (baseUrl) launch.ANTHROPIC_BASE_URL = baseUrl;
  return launch;
}

function containerOf(ctx: DurableObjectState): Container {
  if (!ctx.container) {
    throw new Error("ClaudeCodeAgent needs a container: see wrangler.jsonc");
  }
  return ctx.container;
}

/** A named image from the `images` map in wrangler.jsonc. */
function imageOf(ctx: DurableObjectState, name: string): string | undefined {
  // SAFETY: `images` is part of the `durable_object` scheduling policy's
  // container API, which this workers-types version does not declare yet.
  const images = (ctx.container as { images?: Record<string, string> }).images;
  return images?.[name];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
