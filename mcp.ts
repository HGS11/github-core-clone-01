import type { Store, Repository, Issue, PullRequest } from "./store.ts";
import { createRepository, findRepository, createIssue, createPull, fixedIdentityLine, fixedTimestamp } from "./store.ts";
import type { ParsedRequestUrl } from "./httputil.ts";
import { readBody, parseJson, sendJson, checkAuth } from "./httputil.ts";
import { getObject, parseCommit, flattenTree, buildTreeFromFlatMap, buildCommit, storeObject, findMergeBase } from "./gitcore.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const SERVER_NAME = "legacy-mcp";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";

const TOOL_DEFINITIONS = [
  { name: "create_repo", description: "Create a repository for the authenticated user.", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" } }, required: ["name"] } },
  { name: "get_repo", description: "Get a repository owned by the authenticated user.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
  { name: "create_issue", description: "Create an issue in a repository.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } },
  { name: "list_issues", description: "List repository issues in creation order.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] } },
  { name: "create_pull_request", description: "Create a pull request between repository branches.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, head: { type: "string" }, base: { type: "string" } }, required: ["owner", "repo", "title", "head", "base"] } },
  { name: "merge_pull_request", description: "Squash merge a pull request.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "integer" } }, required: ["owner", "repo", "pull_number"] } },
];

type JsonRpcId = string | number | null;

function responseEnvelope(id: JsonRpcId, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function errorEnvelope(id: JsonRpcId, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendRpcError(response: ServerResponse, id: JsonRpcId, code: number, message: string): void {
  sendJson(response, 200, errorEnvelope(id, code, message));
}

function handleDiscover(response: ServerResponse, id: JsonRpcId): void {
  sendRpcError(response, id, -32601, "Method not found");
}

function handleInitialize(response: ServerResponse, id: JsonRpcId, params: Record<string, unknown>): void {
  const offered = params.protocolVersion;
  const protocolVersion = typeof offered === "string" && offered.length > 0 ? offered : DEFAULT_PROTOCOL_VERSION;
  sendJson(response, 200, responseEnvelope(id, {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  }));
}

function handleToolsList(response: ServerResponse, id: JsonRpcId): void {
  sendJson(response, 200, responseEnvelope(id, { tools: TOOL_DEFINITIONS }));
}

function repositoryView(repository: Repository): object {
  return {
    id: repository.id,
    name: repository.name,
    full_name: repository.fullName,
    description: repository.description,
    private: repository.isPrivate,
    default_branch: repository.defaultBranch,
    owner: { login: repository.owner },
  };
}

function issueView(issue: Issue): object {
  return {
    number: issue.number,
    id: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labelNames.map((name) => ({ name })),
  };
}

function pullView(pull: PullRequest): object {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

type ToolFailure = { code: number; message: string };

function fail(code: number, message: string): ToolFailure {
  return { code, message };
}

function requiredString(args: Record<string, unknown>, name: string): string | ToolFailure {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) return fail(-32602, `Missing or invalid required argument: ${name}`);
  return value;
}

function isFailure(value: unknown): value is ToolFailure {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

function findOwnedRepo(store: Store, owner: string, repo: string): Repository | ToolFailure {
  const found = findRepository(store, owner, repo);
  return found ?? fail(-32602, `Repository not found: ${owner}/${repo}`);
}

function branchKey(branch: string): string {
  return `refs/heads/${branch}`;
}

function sameEntry(a: { sha: string; mode: string } | undefined, b: { sha: string; mode: string } | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.sha === b.sha && a.mode === b.mode;
}

function flatTreeForTip(repository: Repository, tip: string | undefined): Map<string, { sha: string; mode: string }> {
  if (!tip) return new Map();
  const object = getObject(repository, tip);
  if (!object || object.type !== "commit") return new Map();
  const commit = parseCommit(object.payload);
  return flattenTree(repository, commit.tree);
}

function mergePull(repository: Repository, pull: PullRequest, store: Store): object | ToolFailure {
  if (pull.merged) return pullView(pull);
  const baseTip = repository.refs.get(branchKey(pull.baseRef));
  const headTip = repository.refs.get(branchKey(pull.headRef));
  let mergeBase: string | undefined;
  if (baseTip && headTip) mergeBase = findMergeBase(repository, baseTip, headTip) ?? undefined;
  const baseMap = flatTreeForTip(repository, baseTip);
  const headMap = flatTreeForTip(repository, headTip);
  const mergeBaseMap = flatTreeForTip(repository, mergeBase);
  const paths = new Set([...mergeBaseMap.keys(), ...headMap.keys(), ...baseMap.keys()]);
  const merged = new Map<string, { sha: string; mode: string }>();
  for (const path of paths) {
    const ancestor = mergeBaseMap.get(path);
    const head = headMap.get(path);
    const base = baseMap.get(path);
    let chosen: { sha: string; mode: string } | undefined;
    if (sameEntry(head, ancestor)) chosen = base;
    else if (sameEntry(base, ancestor)) chosen = head;
    else if (sameEntry(head, base)) chosen = head;
    else return fail(-32602, `Merge conflict at path: ${path}`);
    if (chosen) merged.set(path, chosen);
  }
  const tree = buildTreeFromFlatMap(repository, merged);
  const parents = baseTip ? [baseTip] : [];
  const identity = fixedIdentityLine(store);
  const payload = buildCommit(tree, parents, identity, identity, pull.title);
  const commitHash = storeObject(repository, "commit", payload);
  repository.refs.set(branchKey(pull.baseRef), commitHash);
  pull.state = "closed";
  pull.merged = true;
  pull.mergedAt = fixedTimestamp();
  pull.mergeCommitSha = commitHash;
  return pullView(pull);
}

function runTool(store: Store, name: string, rawArgs: unknown): unknown | ToolFailure {
  const args = typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
  if (name === "create_repo") {
    const repoName = requiredString(args, "name");
    if (isFailure(repoName)) return repoName;
    const description = typeof args.description === "string" ? args.description : "";
    const isPrivate = typeof args.private === "boolean" ? args.private : false;
    const repository = createRepository(store, repoName, isPrivate, description);
    return repository ? repositoryView(repository) : fail(-32602, `Repository already exists: ${repoName}`);
  }
  if (name === "get_repo" || name === "create_issue" || name === "list_issues" || name === "create_pull_request" || name === "merge_pull_request") {
    const owner = requiredString(args, "owner");
    const repo = requiredString(args, "repo");
    if (isFailure(owner)) return owner;
    if (isFailure(repo)) return repo;
    const repository = findOwnedRepo(store, owner, repo);
    if (isFailure(repository)) return repository;
    if (name === "get_repo") return repositoryView(repository);
    if (name === "create_issue") {
      const title = requiredString(args, "title");
      if (isFailure(title)) return title;
      const body = typeof args.body === "string" ? args.body : "";
      const issue = createIssue(repository, title, body, []);
      return issue ? issueView(issue) : fail(-32602, "Issue could not be created");
    }
    if (name === "list_issues") {
      const state = args.state;
      const issues = repository.issueOrder.map((number) => repository.issues.get(number)).filter((issue): issue is Issue => issue !== undefined);
      const selected = state === "open" || state === "closed" ? issues.filter((issue) => issue.state === state) : issues;
      return selected.map(issueView);
    }
    if (name === "create_pull_request") {
      const title = requiredString(args, "title");
      const head = requiredString(args, "head");
      const base = requiredString(args, "base");
      if (isFailure(title)) return title;
      if (isFailure(head)) return head;
      if (isFailure(base)) return base;
      const headTip = repository.refs.get(branchKey(head));
      const baseTip = repository.refs.get(branchKey(base));
      if (!headTip || !baseTip) return fail(-32602, "Head or base branch does not exist");
      const body = typeof args.body === "string" ? args.body : "";
      return pullView(createPull(repository, head, base, headTip, baseTip, title, body));
    }
    const rawNumber = args.pull_number;
    let number: number;
    if (typeof rawNumber === "number" && Number.isInteger(rawNumber)) number = rawNumber;
    else if (typeof rawNumber === "string" && /^\d+$/.test(rawNumber)) number = Number(rawNumber);
    else return fail(-32602, "Missing or invalid required argument: pull_number");
    const pull = repository.pulls.get(number);
    if (!pull) return fail(-32602, `Pull request not found: ${number}`);
    return mergePull(repository, pull, store);
  }
  return fail(-32601, "Tool not found");
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requestId(value: Record<string, unknown>): JsonRpcId {
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sendToolResult(response: ServerResponse, id: JsonRpcId, value: unknown): void {
  sendJson(response, 200, responseEnvelope(id, {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  }));
}

export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: Store,
  context: { token: string; url: ParsedRequestUrl },
): Promise<void> {
  let parsed: ReturnType<typeof parseJson>;
  try {
    const body = await readBody(request);
    parsed = parseJson(body);
  } catch {
    parsed = { ok: false } as ReturnType<typeof parseJson>;
  }
  if (!parsed.ok) {
    sendJson(response, 400, errorEnvelope(null, -32700, "Parse error"));
    return;
  }

  const bodyValue: unknown = parsed.value;
  const record = isPlainObject(bodyValue) ? bodyValue : {};
  const id = requestId(record);
  if (!checkAuth(request, context.token)) {
    sendJson(response, 401, errorEnvelope(hasOwn(record, "id") ? id : null, -32000, "Unauthorized"));
    return;
  }

  if (!isPlainObject(bodyValue) || typeof record.method !== "string") {
    sendRpcError(response, hasOwn(record, "id") ? id : null, -32600, "Invalid request");
    return;
  }
  if (!hasOwn(record, "id")) {
    sendJson(response, 200, {});
    return;
  }
  if (typeof record.id !== "string" && typeof record.id !== "number") {
    sendRpcError(response, null, -32600, "Invalid request");
    return;
  }
  const requestIdValue = record.id;
  const params = isPlainObject(record.params) ? record.params : {};
  try {
    if (record.method === "server/discover") {
      handleDiscover(response, requestIdValue);
      return;
    }
    if (record.method === "initialize") {
      handleInitialize(response, requestIdValue, params);
      return;
    }
    if (record.method === "tools/list") {
      handleToolsList(response, requestIdValue);
      return;
    }
    if (record.method === "tools/call") {
      const toolName = params.name;
      if (typeof toolName !== "string") {
        sendRpcError(response, requestIdValue, -32602, "Missing or invalid required argument: name");
        return;
      }
      const value = runTool(store, toolName, params.arguments);
      if (isFailure(value)) {
        sendRpcError(response, requestIdValue, value.code, value.message);
        return;
      }
      sendToolResult(response, requestIdValue, value);
      return;
    }
    sendRpcError(response, requestIdValue, -32601, "Method not found");
  } catch (error) {
    const message = error instanceof Error && error.message ? `Internal error: ${error.message}` : "Internal error";
    sendRpcError(response, requestIdValue, -32603, message);
  }
}

