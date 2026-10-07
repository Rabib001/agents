import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { FileUIPart, ModelMessage, UIMessage } from "ai";
import type { ThinkTestAgent } from "./agents/think-session";

/**
 * #2504: a stored file part whose `url` is relative (an app's own file
 * route) used to fail every later turn of the chat, because AI SDK v7's
 * `convertToModelMessages` parses each file url with `new URL()`.
 */

async function freshAgent() {
  return getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    `relative-file-${crypto.randomUUID()}`
  );
}

const relativeFile: FileUIPart = {
  type: "file",
  url: "/api/files/abc",
  mediaType: "text/plain",
  filename: "notes.txt"
};

const reference = "[attachment notes.txt (text/plain) at /api/files/abc]";

function userMessage(parts: UIMessage["parts"]): UIMessage {
  return { id: crypto.randomUUID(), role: "user", parts };
}

describe("Think — file parts with a relative url (#2504)", () => {
  it("sends the model a text reference and keeps later turns working", async () => {
    const agent = await freshAgent();

    const first = await agent.testChatWithUIMessage(
      userMessage([relativeFile])
    );
    expect(first.error).toBeUndefined();
    expect(first.done).toBe(true);
    expect((await agent.getModelPromptsForTest()).at(-1)).toContain(
      `user: ${reference}`
    );

    const second = await agent.testChat("and now?");
    expect(second.error).toBeUndefined();
    expect(second.done).toBe(true);
  });

  it("leaves the stored message unchanged", async () => {
    const agent = await freshAgent();
    const message = userMessage([relativeFile]);

    await agent.testChatWithUIMessage(message);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const stored = messages.find((m) => m.id === message.id);
    expect(stored?.parts).toEqual([relativeFile]);
  });

  it("keeps file parts with an absolute or data: url as files", async () => {
    const agent = await freshAgent();
    // The model gets its own messages, so the mock never downloads the
    // https file; beforeTurn still sees the assembled ones.
    await agent.setTurnConfigOverride({
      messages: [{ role: "user", content: "hi" }]
    });

    await agent.testChatWithUIMessage(
      userMessage([
        relativeFile,
        {
          type: "file",
          url: "https://example.com/cat.png",
          mediaType: "image/png",
          filename: "cat.png"
        },
        {
          type: "file",
          url: "data:text/plain;base64,aGk=",
          mediaType: "text/plain"
        }
      ])
    );

    const assembled = JSON.parse(
      (await agent.getLastBeforeTurnMessagesJson()) ?? "[]"
    ) as ModelMessage[];
    expect(assembled.find((m) => m.role === "user")?.content).toMatchObject([
      { type: "text", text: reference },
      {
        type: "file",
        mediaType: "image/png",
        filename: "cat.png",
        data: { type: "url", url: "https://example.com/cat.png" }
      },
      {
        type: "file",
        mediaType: "text/plain",
        data: { type: "url", url: "data:text/plain;base64,aGk=" }
      }
    ]);
  });

  it("runs the turn when beforeTurn returns its own messages", async () => {
    const agent = await freshAgent();
    await agent.setTurnConfigOverride({
      messages: [{ role: "user", content: "notes.txt says hello" }]
    });

    const result = await agent.testChatWithUIMessage(
      userMessage([relativeFile])
    );
    expect(result.error).toBeUndefined();
    expect(result.done).toBe(true);
    expect((await agent.getModelPromptsForTest()).at(-1)).toContain(
      "user: notes.txt says hello"
    );
  });
});
