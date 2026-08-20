/**
 * How to turn a response body into a value.
 *
 * `auto` picks from the `Content-Type`: JSON is parsed, textual types become a
 * string, anything else becomes a `Blob`. The other modes force one decoding
 * regardless of what the server claimed.
 */
export type DecodeMode = "auto" | "json" | "text" | "blob" | "arrayBuffer" | "stream" | "none";

/**
 * Matches `application/json` and the `+json` structured-suffix types such as
 * `application/vnd.api+json`, with or without parameters.
 *
 * Deliberately a prefix match: the clients this replaces compared the header to
 * the exact string `"application/json"`, so every response carrying the
 * entirely ordinary `application/json; charset=utf-8` fell through to the
 * binary branch and silently arrived as an unread stream.
 */
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/** Textual media types that should decode to a string under `auto`. */
const TEXT_TYPE = /^(?:text\/|application\/(?:xml|xhtml\+xml|javascript|ecmascript|x-ndjson)\b)/i;

/** Statuses defined to carry no body, whatever the headers say. */
const BODILESS_STATUS = new Set([204, 205, 304]);

/** The result of encoding a request body. */
export interface EncodedBody {
  body: BodyInit | undefined;
  /**
   * The `Content-Type` to set, or `undefined` to let the platform decide.
   *
   * Multipart bodies must be left alone: `FormData` gets its boundary parameter
   * from the runtime at send time, and setting the header by hand produces a
   * boundary that does not match the payload. Every client this was extracted
   * from special-cased `FormData` for exactly this reason.
   */
  contentType: string | undefined;
}

/** True for body types the platform can send as-is. */
function isPassthroughBody(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof FormData !== "undefined" && value instanceof FormData) ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) ||
    (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
  );
}

/**
 * Prepare a value for sending.
 *
 * Anything the platform understands natively is passed through untouched;
 * everything else is JSON-encoded. `undefined` and `null` produce no body at
 * all, so a bodyless POST does not send the four characters `null`.
 */
export function encodeBody(body: unknown): EncodedBody {
  if (body === undefined || body === null) {
    return { body: undefined, contentType: undefined };
  }

  if (isPassthroughBody(body)) {
    return { body, contentType: undefined };
  }

  return { body: JSON.stringify(body), contentType: "application/json" };
}

/** Whether a response can carry a body at all. */
function hasBody(response: Response, method: string): boolean {
  if (method.toUpperCase() === "HEAD") return false;
  return !BODILESS_STATUS.has(response.status);
}

/**
 * Decode a response body according to `mode`.
 *
 * Returns `undefined` for responses defined to have no body — a `204`, a `304`,
 * or any answer to `HEAD` — rather than calling `.json()` on nothing and
 * throwing a parse error, which is what the code this replaces did.
 */
export async function decodeBody<T>(
  response: Response,
  mode: DecodeMode,
  method: string,
): Promise<T> {
  if (mode === "none" || !hasBody(response, method)) {
    return undefined as T;
  }

  switch (mode) {
    case "stream":
      return response.body as T;
    case "blob":
      return (await response.blob()) as T;
    case "arrayBuffer":
      return (await response.arrayBuffer()) as T;
    case "text":
      return (await response.text()) as T;
    case "json":
      return (await decodeJson(response)) as T;
    case "auto":
      return (await decodeAuto(response)) as T;
  }
}

/**
 * Parse a JSON body, treating an empty one as `undefined`.
 *
 * Read as text first: a zero-length body is a perfectly normal answer to a
 * `POST` that returns nothing, and `response.json()` would reject on it with a
 * parse error that says nothing about what actually happened.
 */
async function decodeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  return JSON.parse(text);
}

/** Choose a decoding from the response's own `Content-Type`. */
async function decodeAuto(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type") ?? "";

  if (JSON_TYPE.test(contentType)) return decodeJson(response);
  if (TEXT_TYPE.test(contentType)) return response.text();

  // No Content-Type at all. Servers omit it most often on small JSON payloads,
  // so try that first, but fall back to the raw text instead of throwing — an
  // untyped body is not itself an error.
  if (contentType === "") {
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return response.blob();
}

/**
 * The response's declared media type, lower-cased and without parameters.
 *
 * `application/json; charset=utf-8` becomes `application/json`, so a caller can
 * compare it for equality. The unmodified header is still on `headers` for
 * anyone who needs the charset or a multipart boundary.
 */
export function contentTypeOf(response: Response): string {
  const header = response.headers.get("Content-Type");
  if (!header) return "";

  const [mediaType = ""] = header.split(";");
  return mediaType.trim().toLowerCase();
}
