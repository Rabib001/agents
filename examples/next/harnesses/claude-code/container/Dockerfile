# The harness daemon with the Claude Code adapter. `pnpm run build:daemon`
# bundles @cloudflare/harness-daemon into harness-daemon.mjs next to this
# file; the Agent SDK (which carries the Claude Code binary) is installed
# here, pinned to the version the daemon was built against.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm init -y >/dev/null \
  && npm install --omit=dev @anthropic-ai/claude-agent-sdk@0.3.289
COPY harness-daemon.mjs /app/harness-daemon.mjs

# Claude Code refuses bypassPermissions as root; the container is the
# sandbox, so run as an unprivileged user that owns the workspace.
RUN useradd --create-home --uid 10001 agent \
  && mkdir -p /workspace \
  && chown agent:agent /workspace
USER agent
WORKDIR /workspace

ENV CF_HARNESS_ADAPTER=claude-code
ENV DISABLE_AUTOUPDATER=1
EXPOSE 8080
ENTRYPOINT ["node", "/app/harness-daemon.mjs"]
