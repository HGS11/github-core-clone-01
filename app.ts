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

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url: ParsedRequestUrl = parseRequestUrl(req);
      const context = { token, url };
      const segments = url.segments;
      const method = req.method;

      // Answer the public health check.
      if (method === "GET" && segments.length === 1 && segments[0] === "healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Answer the public API root.
      if (method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "v3") {
        sendJson(res, 200, {
          current_user_url: "/api/v3/user",
          rate_limit_url: "/api/v3/rate_limit",
        }, { "X-OAuth-Scopes": "repo, read:org" });
        return;
      }

      // Answer public version metadata.
      if (method === "GET" && segments.length === 3 && segments[0] === "api" && segments[1] === "v3" && segments[2] === "meta") {
        sendJson(res, 200, { installed_version: "1.0.0" });
        return;
      }

      // Protect and route the REST API.
      if (segments.length >= 2 && segments[0] === "api" && segments[1] === "v3") {
        if (!checkAuth(req, token)) {
          sendJsonError(res, 401, "Unauthorized");
          return;
        }
        await handleRestRequest(req, res, store, context);
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
