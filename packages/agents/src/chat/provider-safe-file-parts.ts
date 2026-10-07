import type { FileUIPart, UIMessage } from "ai";

/**
 * Present a message's file parts to the model in a form
 * `convertToModelMessages` accepts.
 *
 * AI SDK v7 reads a file part's `url` with `new URL()`, so a relative url an
 * app stored (e.g. `/api/files/abc`) throws `Invalid URL` and fails every
 * later turn of that chat. Each such part becomes a text reference that keeps
 * its filename, media type and url. Parts whose url parses (absolute or
 * `data:` URLs) or that carry a `providerReference` (sent instead of the url)
 * stay files.
 *
 * This only shapes the model's copy of the transcript, like
 * `truncateOlderMessages`: the input is never mutated, and a message with
 * nothing to replace is returned as is.
 */
export function toProviderSafeFileParts(message: UIMessage): UIMessage {
  let changed = false;
  const parts = message.parts.map((part) => {
    if (
      part.type !== "file" ||
      part.providerReference != null ||
      URL.canParse(part.url)
    ) {
      return part;
    }
    changed = true;
    return { type: "text" as const, text: fileReference(part) };
  });
  return changed ? { ...message, parts } : message;
}

/** e.g. `[attachment notes.txt (text/plain) at /api/files/abc]` */
function fileReference(part: FileUIPart): string {
  const name = part.filename ? `${part.filename} ` : "";
  return `[attachment ${name}(${part.mediaType}) at ${part.url}]`;
}
