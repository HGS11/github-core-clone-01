import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Store } from "./store.ts";
import { createStore } from "./store.ts";
import type { ParsedRequestUrl } from "./httputil.ts";
import { parseRequestUrl, checkAuth, sendJson, sendJsonError } from "./httputil.ts";
import { handleGitRequest } from "./git.ts";
import { handleRestRequest } from "./rest.ts";
import { handleGraphqlRequest } from "./graphql.ts";
import { handleMcpRequest } from "./mcp.ts";

// Create one app with one shared store.
export function createApp(token: string) {
  const store: Store = createStore();
  let version = 0;
  const responseCache = new Map<string, {
    version: number;
    statusCode: number;
    headers: Record<string, string | number | readonly string[]>;
    body: Buffer;
  }>();
  const cacheLimit = 256;

  async function runCached(
    req: IncomingMessage,
    res: ServerResponse,
    handler: (response: ServerResponse) => void | Promise<void>,
  ): Promise<void> {
    const key = JSON.stringify([
      req.method,
      req.headers.host,
      req.url,
      req.headers.authorization,
    ]);
    const cached = responseCache.get(key);
    if (cached?.version === version) {
      res.statusCode = cached.statusCode;
      for (const [name, value] of Object.entries(cached.headers)) res.setHeader(name, value);
      res.end(cached.body);
      return;
    }

    const chunks: Buffer[] = [];
    const explicitlySetHeaders = new Set<string>();
    let statusCode = res.statusCode;
    const capture = new Proxy(res, {
      get(target, property) {
        if (property === "statusCode") return statusCode;
        if (property === "writableEnded") return target.writableEnded;
        if (property === "setHeader") return (name: string, value: string | number | readonly string[]) => {
          explicitlySetHeaders.add(name.toLowerCase());
          return target.setHeader(name, value);
        };
        if (property === "write") return (chunk: string | Uint8Array, ...args: unknown[]) => {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk, (args[0] as BufferEncoding) || "utf8") : Buffer.from(chunk);
          chunks.push(bytes);
          return (target.write as (...writeArgs: unknown[]) => boolean)(chunk, ...args);
        };
        if (property === "end") return (chunk?: string | Uint8Array, ...args: unknown[]) => {
          if (chunk !== undefined && typeof chunk !== "function") {
            const bytes = typeof chunk === "string" ? Buffer.from(chunk, (args[0] as BufferEncoding) || "utf8") : Buffer.from(chunk);
            chunks.push(bytes);
          }
          return (target.end as (...endArgs: unknown[]) => ServerResponse)(chunk, ...args);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, property, value) {
        if (property === "statusCode") {
          statusCode = value;
          target.statusCode = value;
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });

    await handler(capture);
    if (statusCode < 500 && res.writableEnded) {
      const headers = { ...res.getHeaders() } as Record<string, string | number | readonly string[]>;
      // Node adds Date automatically when the first bytes are written. Let it
      // generate a fresh value on a cache hit, as it does for a normal reply.
      if (!explicitlySetHeaders.has("date")) delete headers.date;
      responseCache.delete(key);
      responseCache.set(key, { version, statusCode, headers, body: Buffer.concat(chunks) });
      if (responseCache.size > cacheLimit) responseCache.delete(responseCache.keys().next().value!);
    }
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") version++;
    try {
      const url: ParsedRequestUrl = parseRequestUrl(req);
      const context = { token, url };
      const segments = url.segments;
      const method = req.method;

      // Answer the public health check.
      if (method === "GET" && segments.length === 1 && segments[0] === "healthz") {
        await runCached(req, res, response => sendJson(response, 200, { ok: true }));
        return;
      }

      // Answer the public API root.
      if (method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "v3") {
        await runCached(req, res, response => sendJson(response, 200, {
          current_user_url: "/api/v3/user",
          rate_limit_url: "/api/v3/rate_limit",
        }, { "X-OAuth-Scopes": "repo, read:org" }));
        return;
      }

      // Answer public version metadata.
      if (method === "GET" && segments.length === 3 && segments[0] === "api" && segments[1] === "v3" && segments[2] === "meta") {
        await runCached(req, res, response => sendJson(response, 200, { installed_version: "1.0.0" }));
        return;
      }

      // Protect and route the REST API.
      if (segments.length >= 2 && segments[0] === "api" && segments[1] === "v3") {
        if (!checkAuth(req, token)) {
          sendJsonError(res, 401, "Unauthorized");
          return;
        }
        if (method === "GET") await runCached(req, res, response => handleRestRequest(req, response, store, context));
        else await handleRestRequest(req, res, store, context);
        return;
      }

      // Send GraphQL requests to their handler.
      if (method === "POST" && segments.length === 2 && segments[0] === "api" && segments[1] === "graphql") {
        await handleGraphqlRequest(req, res, store, context);
        return;
      }

      // Send MCP requests to their handler.
      if (method === "POST" && segments.length === 1 && segments[0] === "mcp") {
        await handleMcpRequest(req, res, store, context);
        return;
      }

      // Match repository git operations.
      const gitSuffix = segments.length >= 3
        && segments[1].endsWith(".git")
        && ((segments[2] === "info" && segments[3] === "refs")
          || segments[2] === "git-upload-pack"
          || segments[2] === "git-receive-pack");
      if (gitSuffix) {
        await handleGitRequest(req, res, store, context);
        return;
      }

      // Report paths without a route.
      sendJsonError(res, 404, "Not Found");
    } catch {
      // Return a safe error if no reply has started.
      if (!res.writableEnded) {
        sendJsonError(res, 500, "Internal Server Error");
      }
    }
  });
}
