import { describe, expect, it } from "vitest";
import { convertToModelMessages } from "ai";
import type { UIMessage } from "ai";
import { toProviderSafeFileParts } from "../provider-safe-file-parts";

function message(
  parts: UIMessage["parts"],
  role: UIMessage["role"] = "user"
): UIMessage {
  return { id: "m1", role, parts };
}

describe("toProviderSafeFileParts", () => {
  it("turns a file part with a relative url into a text reference", async () => {
    const stored = message([
      { type: "text", text: "Summarize this" },
      {
        type: "file",
        url: "/api/files/abc",
        mediaType: "text/plain",
        filename: "notes.txt"
      }
    ]);
    await expect(convertToModelMessages([stored])).rejects.toThrow(TypeError);

    const safe = toProviderSafeFileParts(stored);

    expect(safe.parts).toEqual([
      { type: "text", text: "Summarize this" },
      {
        type: "text",
        text: "[attachment notes.txt (text/plain) at /api/files/abc]"
      }
    ]);
    expect(stored.parts[1].type).toBe("file");
    await expect(convertToModelMessages([safe])).resolves.toHaveLength(1);
  });

  it("leaves the filename out of the reference when the part has none", () => {
    const safe = toProviderSafeFileParts(
      message(
        [{ type: "file", url: "files/abc", mediaType: "image/png" }],
        "assistant"
      )
    );
    expect(safe.parts).toEqual([
      { type: "text", text: "[attachment (image/png) at files/abc]" }
    ]);
  });

  it("returns the message as is when every file url parses", () => {
    const stored = message([
      {
        type: "file",
        url: "https://example.com/cat.png",
        mediaType: "image/png"
      },
      {
        type: "file",
        url: "data:text/plain;base64,aGk=",
        mediaType: "text/plain"
      }
    ]);
    expect(toProviderSafeFileParts(stored)).toBe(stored);
  });

  it("keeps a file part with a providerReference, which is sent instead of its url", () => {
    const stored = message([
      {
        type: "file",
        url: "/api/files/abc",
        mediaType: "application/pdf",
        providerReference: { openai: "file-123" }
      }
    ]);
    expect(toProviderSafeFileParts(stored)).toBe(stored);
  });
});
