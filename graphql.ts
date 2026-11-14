import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { findRepository, listRepositories, getViewer, createIssue, createPull, addComment, fixedTimestamp } from "./store.ts";
import type { Store, Repository, Issue, PullRequest, Comment, User } from "./store.ts";
import { readBody, parseJson, sendJson, sendJsonError, checkAuth } from "./httputil.ts";
import type { JsonParseResult, ParsedRequestUrl } from "./httputil.ts";
import { getObject, parseCommit, flattenTree } from "./gitcore.ts";
import type { StoredObject, ParsedCommit, FlatEntry } from "./gitcore.ts";

type VariableValue = { kind: "variable"; name: string };
type GqlValue = string | number | boolean | null | VariableValue | GqlValue[] | { [key: string]: GqlValue };
type FieldSelection = { kind: "field"; key: string; name: string; args: Record<string, GqlValue>; selections: Selection[] };
type InlineSelection = { kind: "inline"; typeName: string; selections: Selection[] };
type Selection = FieldSelection | InlineSelection;
type Operation = { operation: string; name: string; variables: string[]; selections: Selection[] };
type Token = { kind: "name" | "string" | "int" | "punct" | "eof"; value: string };

function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") { i++; continue; }
    if (/[A-Za-z0-9_]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      out.push({ kind: "name", value: source.slice(i, j) }); i = j; continue;
    }
    if (c === '"') {
      let j = i + 1, value = "";
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") {
          j++;
          const e = source[j++];
          const decoded: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
          if (e === undefined) throw new Error("Unterminated string");
          value += decoded[e] ?? e;
        } else value += source[j++];
      }
      if (source[j] !== '"') throw new Error("Unterminated string");
      out.push({ kind: "string", value }); i = j + 1; continue;
    }
    if (c === "-" || /[0-9]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[0-9]/.test(source[j])) j++;
      out.push({ kind: "int", value: source.slice(i, j) }); i = j; continue;
    }
    if (source.slice(i, i + 3) === "...") { out.push({ kind: "punct", value: "..." }); i += 3; continue; }
    if ("{}():![]$".includes(c)) { out.push({ kind: "punct", value: c }); i++; continue; }
    throw new Error(`Unexpected character ${c}`);
  }
  out.push({ kind: "eof", value: "" });
  return out;
}

class Parser {
  private tokens: Token[];
  private position: number;
  constructor(tokens: Token[]) { this.tokens = tokens; this.position = 0; }
  private peek(): Token { return this.tokens[this.position]; }
  private take(): Token { return this.tokens[this.position++]; }
  private expect(value: string): Token {
    const token = this.take();
    if (token.value !== value) throw new Error(`Expected ${value}`);
    return token;
  }
  private name(): string {
    const token = this.take();
    if (token.kind !== "name") throw new Error("Expected name");
    return token.value;
  }
  parse(): Operation {
    const operation = this.name();
    if (operation !== "query" && operation !== "mutation") throw new Error("Expected query or mutation");
    const name = this.name();
    const variables: string[] = [];
    if (this.peek().value === "(") {
      this.take();
      while (this.peek().value !== ")") {
        this.expect("$"); variables.push(this.name()); this.expect(":");
        this.parseType();
      }
      this.take();
    }
    return { operation, name, variables, selections: this.selectionSet() };
  }
  private parseType(): void {
    if (this.peek().value === "[") { this.take(); this.parseType(); this.expect("]"); }
    else this.name();
    if (this.peek().value === "!") this.take();
  }
  private selectionSet(): Selection[] {
    this.expect("{");
    const selections: Selection[] = [];
    while (this.peek().value !== "}") {
      if (this.peek().kind === "eof") throw new Error("Unclosed selection set");
      if (this.peek().value === "...") {
        this.take(); this.expect("on"); const typeName = this.name();
        selections.push({ kind: "inline", typeName, selections: this.selectionSet() });
      } else {
        let first = this.name(), name = first, key = first;
        if (this.peek().value === ":") { this.take(); key = first; name = this.name(); }
        const args: Record<string, GqlValue> = {};
        if (this.peek().value === "(") {
          this.take();
          while (this.peek().value !== ")") { const arg = this.name(); this.expect(":"); args[arg] = this.value(); }
          this.take();
        }
        const children = this.peek().value === "{" ? this.selectionSet() : [];
        selections.push({ kind: "field", key, name, args, selections: children });
      }
    }
    this.take();
    return selections;
  }
  private value(): GqlValue {
    const token = this.peek();
    if (token.value === "$") { this.take(); return { kind: "variable", name: this.name() }; }
    if (token.value === "[") {
      this.take(); const values: GqlValue[] = [];
      while (this.peek().value !== "]") values.push(this.value());
      this.take(); return values;
    }
    if (token.value === "{") {
      this.take(); const object: Record<string, GqlValue> = {};
      while (this.peek().value !== "}") { const key = this.name(); this.expect(":"); object[key] = this.value(); }
      this.take(); return object;
    }
    this.take();
    if (token.kind === "string") return token.value;
    if (token.kind === "int") return Number(token.value);
    if (token.value === "true") return true;
    if (token.value === "false") return false;
    if (token.value === "null") return null;
    if (token.kind === "name") return token.value;
    throw new Error("Expected value");
  }
}

function resolveValue(value: GqlValue, vars: Record<string, unknown>): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "kind" in value && value.kind === "variable") return vars[value.name] ?? null;
  if (Array.isArray(value)) return value.map(v => resolveValue(v, vars));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = resolveValue(item as GqlValue, vars);
    return result;
  }
  return value;
}
function argsOf(field: FieldSelection, vars: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) result[key] = resolveValue(value, vars);
  return result;
}
function gid(kind: string, ...parts: number[]): string { return Buffer.from([kind, ...parts].join(":"), "utf8").toString("base64"); }
function decodeId(id: unknown): { kind: string; parts: number[] } | null {
  if (typeof id !== "string" || !id) return null;
  try {
    const decoded = Buffer.from(id, "base64").toString("utf8").split(":");
    if (decoded.length < 2 || decoded.slice(1).some(v => !/^\d+$/.test(v))) return null;
    return { kind: decoded[0], parts: decoded.slice(1).map(Number) };
  } catch { return null; }
}
function cursor(position: number): string { return Buffer.from(`position:${position}`, "utf8").toString("base64"); }
function cursorPosition(value: unknown): number {
  if (typeof value !== "string") return -1;
  try { const m = /^position:(\d+)$/.exec(Buffer.from(value, "base64").toString("utf8")); return m ? Number(m[1]) : -1; } catch { return -1; }
}
function selectionsFlat(selections: Selection[], typeName: string): FieldSelection[] {
  const out: FieldSelection[] = [];
  for (const selection of selections) {
    if (selection.kind === "field") out.push(selection);
    else if (selection.typeName === typeName) out.push(...selectionsFlat(selection.selections, typeName));
  }
  return out;
}
const introspectionFields: Record<string, string[]> = {
  Issue: ["id", "number", "title", "state", "body"],
  PullRequest: ["id", "number", "headRefName", "baseRefName", "mergeable", "state", "merged", "files"],
  Repository: ["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest"]
};
const fieldsByType: Record<string, string[]> = {
  Query: ["viewer", "repository", "node", "__type"], Mutation: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
  Node: ["id"], User: ["login"], Repository: introspectionFields.Repository, Issue: introspectionFields.Issue,
  PullRequest: [...introspectionFields.PullRequest, "title", "body"], IssueConnection: ["nodes", "pageInfo"],
  PullRequestConnection: ["nodes"], ChangedFilesConnection: ["nodes"], ChangedFile: ["path"], PageInfo: ["hasNextPage", "endCursor"],
  Comment: ["id", "body"], DefaultBranchRef: ["name"], CreateIssuePayload: ["issue"], CloseIssuePayload: ["issue"],
  CreatePullRequestPayload: ["pullRequest"], MergePullRequestPayload: ["pullRequest"], AddCommentPayload: ["commentEdge"], CommentEdge: ["node"],
  IntrospectionType: ["fields", "enumValues"], IntrospectionEntry: ["name"],
  SearchType: []
};
function validateSelections(selections: Selection[], typeName: string): string | null {
  for (const s of selections) {
    if (s.kind === "inline") { const error = validateSelections(s.selections, s.typeName); if (error) return error; continue; }
    if (!(fieldsByType[typeName] ?? []).includes(s.name)) return s.name;
    let childType = "";
      if (typeName === "Query") childType = ({ viewer: "User", repository: "Repository", node: "Node", __type: "IntrospectionType" } as Record<string, string>)[s.name];
    else if (typeName === "Mutation") childType = ({ createIssue: "CreateIssuePayload", closeIssue: "CloseIssuePayload", createPullRequest: "CreatePullRequestPayload", mergePullRequest: "MergePullRequestPayload", addComment: "AddCommentPayload" } as Record<string, string>)[s.name];
    else if (typeName === "Repository") childType = ({ owner: "User", defaultBranchRef: "DefaultBranchRef", issue: "Issue", issues: "IssueConnection", pullRequests: "PullRequestConnection", pullRequest: "PullRequest" } as Record<string, string>)[s.name] ?? "";
    else if (typeName === "IssueConnection") childType = s.name === "nodes" ? "Issue" : "PageInfo";
    else if (typeName === "PullRequestConnection") childType = s.name === "nodes" ? "PullRequest" : "";
    else if (typeName === "Issue") childType = "";
    else if (typeName === "PullRequest") childType = s.name === "files" ? "ChangedFilesConnection" : "";
    else if (typeName === "ChangedFilesConnection") childType = "";
    else if (typeName === "PageInfo") childType = "";
    else if (typeName === "AddCommentPayload") childType = "CommentEdge";
    else if (typeName === "CommentEdge") childType = "Comment";
    else if (typeName.endsWith("Payload")) childType = s.name === "issue" ? "Issue" : "PullRequest";
    else if (typeName === "IntrospectionType") childType = "IntrospectionEntry";
    if (s.selections.length && childType) { const error = validateSelections(s.selections, childType); if (error) return error; }
  }
  return null;
}
function issueState(issue: Issue): string { return issue.state === "open" ? "OPEN" : "CLOSED"; }
function pullState(pull: PullRequest): string { return pull.state === "open" ? "OPEN" : pull.merged ? "MERGED" : "CLOSED"; }
function objectForId(store: Store, id: unknown): { kind: string; repo?: Repository; issue?: Issue; pull?: PullRequest; comment?: Comment } | null {
  const decoded = decodeId(id); if (!decoded) return null;
  if (decoded.kind === "r" && decoded.parts.length === 1) {
    const repo = listRepositories(store).find(r => r.id === decoded.parts[0]); return repo ? { kind: "Repository", repo } : null;
  }
  if ((decoded.kind === "i" || decoded.kind === "p") && decoded.parts.length === 2) {
    const repo = listRepositories(store).find(r => r.id === decoded.parts[0]); if (!repo) return null;
    return decoded.kind === "i" ? (repo.issues.get(decoded.parts[1]) ? { kind: "Issue", repo, issue: repo.issues.get(decoded.parts[1]) } : null)
      : (repo.pulls.get(decoded.parts[1]) ? { kind: "PullRequest", repo, pull: repo.pulls.get(decoded.parts[1]) } : null);
  }
  return null;
}
function executeOperation(op: Operation, store: Store, vars: Record<string, unknown>): Record<string, unknown> {
  const invalid = validateSelections(op.selections, op.operation === "query" ? "Query" : "Mutation");
  if (invalid) throw new Error(`Unknown field ${invalid}`);
  const viewer = getViewer(store);
  const allRepos = listRepositories(store);
  const issueRepo = (issue: Issue): Repository | undefined => allRepos.find(r => r.issues.get(issue.number) === issue);
  const pullRepo = (pull: PullRequest): Repository | undefined => allRepos.find(r => r.pulls.get(pull.number) === pull);
  const resolveObject = (type: string, value: unknown, field: FieldSelection): unknown => {
    if (Array.isArray(value)) return value.map(item => resolveObject(type, item, field));
    if (value === null || value === undefined) return null;
    if (field.selections.length === 0) return value;
    const result: Record<string, unknown> = {};
    for (const sub of selectionsFlat(field.selections, type)) {
      const a = argsOf(sub, vars); let v: unknown = null, child = "";
      if (type === "User" && sub.name === "login") v = (value as User).login;
      if (type === "Repository") {
        const r = value as Repository;
        if (sub.name === "id") v = gid("r", r.id);
        if (sub.name === "databaseId") v = r.id;
        if (sub.name === "name") v = r.name;
        if (sub.name === "nameWithOwner") v = r.fullName;
        if (sub.name === "owner") { v = viewer; child = "User"; }
        if (sub.name === "defaultBranchRef") { v = r.refs.has(`refs/heads/${r.defaultBranch}`) ? { name: r.defaultBranch } : null; child = "DefaultBranchRef"; }
        if (sub.name === "viewerPermission") v = "ADMIN";
        if (sub.name === "hasIssuesEnabled") v = true;
        if (sub.name === "issue") { v = r.issues.get(Number(a.number)) ?? null; child = "Issue"; }
        if (sub.name === "pullRequest") { v = r.pulls.get(Number(a.number)) ?? null; child = "PullRequest"; }
        if (sub.name === "issues") {
          let nums = [...r.issueOrder];
          if (Array.isArray(a.states)) nums = nums.filter(n => { const issue = r.issues.get(n); return !!issue && (a.states as unknown[]).includes(issueState(issue)); });
          const order = a.orderBy as Record<string, unknown> | undefined;
          if (order?.field === "CREATED_AT" && order.direction === "DESC") nums.reverse();
          const after = cursorPosition(a.after); const start = after >= 0 ? after + 1 : 0;
          const first = Number.isFinite(Number(a.first)) ? Math.max(0, Number(a.first)) : nums.length;
          const page = nums.slice(start, start + first); const nodes = page.map(n => r.issues.get(n)).filter(Boolean);
          v = { nodes, pageInfo: { hasNextPage: start + page.length < nums.length, endCursor: page.length ? cursor(start + page.length - 1) : null } }; child = "IssueConnection";
        }
        if (sub.name === "pullRequests") { const nums = r.pullOrder.slice(0, Math.max(0, Number(a.first) || r.pullOrder.length)); v = { nodes: nums.map(n => r.pulls.get(n)).filter(Boolean) }; child = "PullRequestConnection"; }
      }
      if (type === "Issue") {
        const issue = value as Issue, repo = issueRepo(issue);
        if (sub.name === "id") v = repo ? gid("i", repo.id, issue.number) : "";
        if (sub.name === "number") v = issue.number; if (sub.name === "title") v = issue.title; if (sub.name === "body") v = issue.body; if (sub.name === "state") v = issueState(issue);
      }
      if (type === "PullRequest") {
        const pull = value as PullRequest, repo = pullRepo(pull);
        if (sub.name === "number") v = pull.number; if (sub.name === "id") v = repo ? gid("p", repo.id, pull.number) : ""; if (sub.name === "title") v = pull.title; if (sub.name === "body") v = pull.body;
        if (sub.name === "state") v = pullState(pull); if (sub.name === "merged") v = pull.merged; if (sub.name === "headRefName") v = pull.headRef; if (sub.name === "baseRefName") v = pull.baseRef; if (sub.name === "mergeable") v = "UNKNOWN";
        if (sub.name === "files") {
          const snapshot = (sha: string): Map<string, FlatEntry> => {
            if (!repo || !sha) return new Map();
            try {
              const object = getObject(repo, sha);
              if (!object) return new Map();
              return flattenTree(repo, parseCommit(object.payload).tree);
            } catch { return new Map(); }
          };
          const base = snapshot(pull.baseSha), head = snapshot(pull.headSha);
          const paths = [...new Set([...base.keys(), ...head.keys()])].filter(path => base.get(path)?.sha !== head.get(path)?.sha).sort();
          const first = a.first === undefined ? paths.length : Math.max(0, Number(a.first));
          v = { nodes: paths.slice(0, first).map(path => ({ path })) }; child = "ChangedFilesConnection";
        }
      }
      if (type === "IssueConnection" && sub.name === "nodes") { v = (value as { nodes: Issue[] }).nodes; child = "Issue"; }
      if (type === "IssueConnection" && sub.name === "pageInfo") { v = (value as { pageInfo: unknown }).pageInfo; child = "PageInfo"; }
      if (type === "PullRequestConnection" && sub.name === "nodes") { v = (value as { nodes: PullRequest[] }).nodes; child = "PullRequest"; }
      if (type === "ChangedFilesConnection" && sub.name === "nodes") { v = (value as { nodes: unknown[] }).nodes; child = "ChangedFile"; }
      if (type === "ChangedFile" && sub.name === "path") v = (value as { path: string }).path;
      if (type === "PageInfo") { if (sub.name === "hasNextPage") v = (value as { hasNextPage: boolean }).hasNextPage; if (sub.name === "endCursor") v = (value as { endCursor: string | null }).endCursor; }
      if (type === "DefaultBranchRef" && sub.name === "name") v = (value as { name: string }).name;
      if (type === "IntrospectionType") { if (sub.name === "fields") { v = ((value as { fields: string[] }).fields).map(name => ({ name })); child = "IntrospectionEntry"; } if (sub.name === "enumValues") { v = ((value as { enumValues: string[] }).enumValues).map(name => ({ name })); child = "IntrospectionEntry"; } }
      if (type === "IntrospectionEntry" && sub.name === "name") v = (value as { name: string }).name;
      if (child) v = resolveObject(child, v, sub);
      result[sub.key] = v;
    }
    return result;
  };
  const root: Record<string, unknown> = {};
  for (const field of selectionsFlat(op.selections, op.operation === "query" ? "Query" : "Mutation")) {
    const a = argsOf(field, vars); let value: unknown = null, type = "";
    if (op.operation === "query") {
      if (field.name === "viewer") { value = viewer; type = "User"; }
      if (field.name === "repository") { value = findRepository(store, String(a.owner ?? ""), String(a.name ?? "")) ?? null; type = "Repository"; }
      if (field.name === "node") { const found = objectForId(store, a.id); value = found?.repo ?? found?.issue ?? found?.pull ?? null; type = found?.kind ?? "Node"; }
      if (field.name === "__type") { const name = String(a.name ?? ""); value = fieldsByType[name] || name === "SearchType" ? { fields: introspectionFields[name] ?? [], enumValues: name === "SearchType" ? ["ISSUE", "REPOSITORY", "USER"] : [] } : null; type = "IntrospectionType"; }
    }
    root[field.key] = type ? resolveObject(type, value, field) : null;
  }
  return root;
}

function mutationOperation(op: Operation, store: Store, vars: Record<string, unknown>): Record<string, unknown> {
  const invalid = validateSelections(op.selections, "Mutation");
  if (invalid) throw new Error(`Unknown field ${invalid}`);
  const root: Record<string, unknown> = {};
  const allRepos = listRepositories(store);
  const issueRepo = (issue: Issue): Repository | undefined => allRepos.find(r => r.issues.get(issue.number) === issue);
  const pullRepo = (pull: PullRequest): Repository | undefined => allRepos.find(r => r.pulls.get(pull.number) === pull);
  const render = (type: string, item: unknown, selections: Selection[]): unknown => {
    if (item === null || item === undefined) return null;
    const result: Record<string, unknown> = {};
    for (const f of selectionsFlat(selections, type)) {
      let v: unknown = null, child = "";
      if (type === "Issue") {
        const issue = item as Issue, repo = issueRepo(issue);
        if (f.name === "id") v = repo ? gid("i", repo.id, issue.number) : "";
        if (f.name === "number") v = issue.number; if (f.name === "title") v = issue.title; if (f.name === "body") v = issue.body; if (f.name === "state") v = issueState(issue);
      } else if (type === "PullRequest") {
        const pull = item as PullRequest, repo = pullRepo(pull);
        if (f.name === "id") v = repo ? gid("p", repo.id, pull.number) : "";
        if (f.name === "number") v = pull.number; if (f.name === "title") v = pull.title; if (f.name === "body") v = pull.body;
        if (f.name === "state") v = pullState(pull); if (f.name === "merged") v = pull.merged; if (f.name === "headRefName") v = pull.headRef; if (f.name === "baseRefName") v = pull.baseRef; if (f.name === "mergeable") v = "UNKNOWN";
      } else if (type === "Comment") { const comment = item as Comment; if (f.name === "id") v = gid("c", comment.id); if (f.name === "body") v = comment.body; }
      else if (type === "CreateIssuePayload" || type === "CloseIssuePayload") { if (f.name === "issue") { v = item; child = "Issue"; } }
      else if (type === "CreatePullRequestPayload" || type === "MergePullRequestPayload") { if (f.name === "pullRequest") { v = item; child = "PullRequest"; } }
      else if (type === "AddCommentPayload" && f.name === "commentEdge") { v = { node: item }; child = "CommentEdge"; }
      else if (type === "CommentEdge" && f.name === "node") { v = (item as { node: Comment }).node; child = "Comment"; }
      result[f.key] = child ? render(child, v, f.selections) : v;
    }
    return result;
  };
  for (const field of selectionsFlat(op.selections, "Mutation")) {
    const args = argsOf(field, vars), input = (args.input ?? {}) as Record<string, unknown>;
    let entity: unknown = null, payloadType = "";
    if (field.name === "createIssue") {
      const found = objectForId(store, input.repositoryId);
      if (!found?.repo || found.kind !== "Repository") throw new Error("Invalid repositoryId");
      entity = createIssue(found.repo, String(input.title ?? ""), String(input.body ?? ""), []); payloadType = "CreateIssuePayload";
    } else if (field.name === "closeIssue") {
      const found = objectForId(store, input.issueId);
      if (!found?.repo || !found.issue) throw new Error("Invalid issueId");
      found.issue.state = "closed"; entity = found.issue; payloadType = "CloseIssuePayload";
    } else if (field.name === "createPullRequest") {
      const found = objectForId(store, input.repositoryId);
      if (!found?.repo || found.kind !== "Repository") throw new Error("Invalid repositoryId");
      const head = String(input.headRefName ?? ""), base = String(input.baseRefName ?? "");
      const headSha = found.repo.refs.get(`refs/heads/${head}`) ?? "", baseSha = found.repo.refs.get(`refs/heads/${base}`) ?? "";
      entity = createPull(found.repo, head, base, headSha, baseSha, String(input.title ?? ""), ""); payloadType = "CreatePullRequestPayload";
    } else if (field.name === "mergePullRequest") {
      const found = objectForId(store, input.pullRequestId);
      if (!found?.pull) throw new Error("Invalid pullRequestId");
      found.pull.merged = true; found.pull.state = "closed"; found.pull.mergedAt = fixedTimestamp(); entity = found.pull; payloadType = "MergePullRequestPayload";
    } else if (field.name === "addComment") {
      const found = objectForId(store, input.subjectId);
      if (!found?.repo || !found.issue) throw new Error("Invalid subjectId");
      entity = addComment(store, found.repo, found.issue.number, String(input.body ?? "")); payloadType = "AddCommentPayload";
    }
    root[field.key] = render(payloadType, entity, field.selections);
  }
  return root;
}

function executeOne(body: unknown, store: Store): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ message: "Operation must be an object" }] };
  const record = body as Record<string, unknown>;
  if (typeof record.query !== "string") return { errors: [{ message: "Query must be a string" }] };
  try {
    const op = new Parser(tokenize(record.query)).parse();
    const variables = record.variables && typeof record.variables === "object" && !Array.isArray(record.variables) ? record.variables as Record<string, unknown> : {};
    const data = op.operation === "mutation" ? mutationOperation(op, store, variables) : executeOperation(op, store, variables);
    return { data };
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : "GraphQL execution failed" }] };
  }
}

type GraphqlContext = { token: string; url: ParsedRequestUrl };
async function handleGraphqlRequest(request: IncomingMessage, response: ServerResponse, store: Store, context: GraphqlContext): Promise<void> {
  if (!checkAuth(request, context.token)) {
    sendJsonError(response, 401, "Unauthorized");
    return;
  }
  const bodyBuffer = await readBody(request);
  const parsed: JsonParseResult = parseJson(bodyBuffer);
  if (!parsed.ok) {
    sendJsonError(response, 400, "Malformed JSON request body");
    return;
  }
  const body = parsed.value;
  if (Array.isArray(body)) {
    sendJson(response, 200, body.map(item => executeOne(item, store)));
    return;
  }
  sendJson(response, 200, executeOne(body, store));
}

export { handleGraphqlRequest };
