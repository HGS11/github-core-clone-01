import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

export const fixedRequestId = "0123456789abcdef0123456789abcdef";

export function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false };

export function parseJson(input: Buffer): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(input.toString("utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (extraHeaders) {
    for (const [name, headerValue] of Object.entries(extraHeaders)) {
      response.setHeader(name, headerValue);
    }
  }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-GitHub-Request-Id", fixedRequestId);

  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.statusCode = statusCode;
  response.setHeader("Content-Length", bytes.byteLength);
  response.end(bytes);
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  extraHeaders?: Record<string, string>,
): void {
  writeJson(response, statusCode, value, extraHeaders);
}

export function sendJsonError(response: ServerResponse, statusCode: number, message: string): void {
  writeJson(response, statusCode, { message });
}

let lastExpectedToken: string | undefined;
let lastExpectedAuthorization: string;

export function checkAuth(request: IncomingMessage, expectedToken: string): boolean {
  const authorization = request.headers.authorization;
  if (expectedToken !== lastExpectedToken) {
    lastExpectedToken = expectedToken;
    lastExpectedAuthorization = `Bearer ${expectedToken}`;
  }
  return authorization === lastExpectedAuthorization;
}

export type ParsedRequestUrl = {
  segments: string[];
  query: URLSearchParams;
};

const parsedRequestUrlCache = new Map<string, ParsedRequestUrl>();
const parsedRequestUrlCacheLimit = 256;

export function parseRequestUrl(request: IncomingMessage): ParsedRequestUrl {
  const target = request.url ?? "";
  const cached = parsedRequestUrlCache.get(target);
  if (cached) return cached;

  let result: ParsedRequestUrl;
  try {
    const parsed = new URL(target, "http://placeholder.invalid");
    const segments = parsed.pathname
      .split("/")
      .filter((piece) => piece.length > 0)
      .map((piece) => {
        try {
          return decodeURIComponent(piece);
        } catch {
          return piece;
        }
      });
    result = { segments, query: parsed.searchParams };
  } catch {
    result = { segments: [], query: new URLSearchParams() };
  }

  parsedRequestUrlCache.set(target, result);
  if (parsedRequestUrlCache.size > parsedRequestUrlCacheLimit) {
    const oldestTarget = parsedRequestUrlCache.keys().next().value;
    if (oldestTarget !== undefined) parsedRequestUrlCache.delete(oldestTarget);
  }
  return result;
}

export function paginate<T>(
  fullArray: T[],
  perPage: number,
  pageNumber: number,
): { items: T[]; hasMore: boolean } {
  const page = Math.max(1, pageNumber);
  const start = (page - 1) * perPage;
  const items = fullArray.slice(start, start + perPage);
  return { items, hasMore: start + items.length < fullArray.length };
}
