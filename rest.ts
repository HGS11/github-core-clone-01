import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createRepository,
  findRepository,
  deleteRepository,
  listRepositories,
  getViewer,
  createIssue,
  createPull,
  addComment,
  fixedIdentityLine,
  fixedTimestamp,
  type Store,
  type Repository,
  type Issue,
  type PullRequest,
  type Comment,
  type Label,
} from "./store.ts";
import {
  fixedRequestId,
  readBody,
  parseJson,
  sendJson,
  sendJsonError,
  paginate,
  type ParsedRequestUrl,
} from "./httputil.ts";
import {
  storeObject,
  getObject,
  parseCommit,
  buildCommit,
  flattenTree,
  buildTreeFromFlatMap,
  listAncestors,
  findMergeBase,
  type FlatEntry,
} from "./gitcore.ts";

type RestContext = { token: string; url: ParsedRequestUrl };
type JsonObject = Record<string, unknown>;

function repositoryView(store: Store, repository: Repository) {
  const viewer = getViewer(store);
  return {
    id: repository.id,
    name: repository.name,
    full_name: repository.fullName,
    owner: { login: viewer.login, id: viewer.id },
    private: repository.isPrivate,
    description: repository.description,
    default_branch: repository.defaultBranch,
  };
}

function issueView(repository: Repository, issue: Issue) {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labelNames.map((name) => ({
      name,
      color: repository.labels.get(name)?.color ?? "",
    })),
  };
}

function pullView(pull: PullRequest) {
  return {
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt || null,
    merge_commit_sha: pull.mergeCommitSha || null,
  };
}

async function readObjectBody(request: IncomingMessage): Promise<JsonObject | null> {
  const parsed = parseJson(await readBody(request));
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return null;
  return parsed.value as JsonObject;
}

function branchTip(repository: Repository, branch: string): string | undefined {
  return repository.refs.get(`refs/heads/${branch}`);
}

function flatAt(repository: Repository, hash: string | undefined): Map<string, FlatEntry> {
  if (!hash) return new Map();
  const object = getObject(repository, hash);
  if (!object || object.type !== "commit") return new Map();
  return flattenTree(repository, parseCommit(object.payload).tree);
}

function createCommitFromFlat(
  store: Store,
  repository: Repository,
  branch: string,
  flat: Map<string, FlatEntry>,
  message: string,
  oldTip: string | undefined,
): string {
  const tree = buildTreeFromFlatMap(repository, flat);
  const identity = fixedIdentityLine(store);
  const payload = buildCommit(tree, oldTip ? [oldTip] : [], identity, identity, message);
  const hash = storeObject(repository, "commit", payload);
  repository.refs.set(`refs/heads/${branch}`, hash);
  return hash;
}

function positiveQuery(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function issueNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function encodeBase64(value: Buffer): string {
  return value.toString("base64");
}

function sameHash(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

export async function handleRestRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: Store,
  context: RestContext,
): Promise<void> {
  const { segments, query } = context.url;
  const method = request.method ?? "";
  const notFound = () => sendJsonError(response, 404, "Not Found");
  const badRequest = () => sendJsonError(response, 400, "Bad Request");
  if (segments[0] !== "api" || segments[1] !== "v3") return notFound();

  if (method === "GET" && segments.length === 2) return sendJson(response, 200, {}, { "X-OAuth-Scopes": "repo, read:org" });
  if (method === "GET" && segments.length === 3 && segments[2] === "meta") return sendJson(response, 200, { installed_version: "1.0.0" });

  if (segments.length === 4 && segments[2] === "user" && segments[3] === "repos") {
    if (method === "POST") {
      const body = await readObjectBody(request);
      if (!body) return badRequest();
      if (!isString(body.name) || body.name.length === 0) return sendJsonError(response, 422, "Invalid repository name");
      const repository = createRepository(store, body.name, body.private === true, isString(body.description) ? body.description : "");
      if (!repository) return sendJsonError(response, 422, "Repository already exists");
      return sendJson(response, 201, repositoryView(store, repository));
    }
    if (method === "GET") {
      const perPage = positiveQuery(query.get("per_page"), 30);
      const page = positiveQuery(query.get("page"), 1);
      const views = listRepositories(store).map((repository) => repositoryView(store, repository));
      const result = paginate(views, perPage, page);
      const headers = result.hasMore
        ? { Link: `<http://${request.headers.host ?? "localhost"}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"` }
        : undefined;
      return sendJson(response, 200, result.items, headers);
    }
  }

  if (segments[2] === "repos" && segments.length >= 5) {
    const owner = segments[3];
    const name = segments[4];
    const repository = findRepository(store, owner, name);
    const isRepositoryPath = segments.length === 5;
    if (isRepositoryPath && method === "GET") {
      if (!repository) return notFound();
      return sendJson(response, 200, repositoryView(store, repository));
    }
    if (isRepositoryPath && method === "PATCH") {
      const body = await readObjectBody(request);
      if (!body) return badRequest();
      if (!repository) return notFound();
      if (isString(body.description)) repository.description = body.description;
      return sendJson(response, 200, repositoryView(store, repository));
    }
    if (isRepositoryPath && method === "DELETE") {
      if (!deleteRepository(store, owner, name)) return notFound();
      response.statusCode = 204;
      response.setHeader("X-GitHub-Request-Id", fixedRequestId);
      response.end();
      return;
    }

    if (segments.length === 7 && segments[5] === "git" && segments[6] === "refs" && method === "POST") {
      if (!repository) return notFound();
      const body = await readObjectBody(request);
      if (!body) return badRequest();
      if (!isString(body.ref) || !body.ref || !isString(body.sha) || !body.sha) return badRequest();
      repository.refs.set(body.ref, body.sha);
      return sendJson(response, 201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (segments.length === 6 && segments[5] === "branches" && method === "GET") {
      if (!repository) return notFound();
      const branches = Array.from(repository.refs.entries()).flatMap(([ref, sha]) =>
        ref.startsWith("refs/heads/") ? [{ name: ref.slice("refs/heads/".length), commit: { sha }, protected: false }] : [],
      );
      return sendJson(response, 200, branches);
    }
    if (segments.length === 6 && segments[5] === "commits" && method === "GET") {
      if (!repository) return notFound();
      const tip = branchTip(repository, isString(query.get("sha")) ? query.get("sha") : repository.defaultBranch);
      if (!tip) return sendJson(response, 200, []);
      const commits = listAncestors(repository, tip).flatMap((sha) => {
        const object = getObject(repository, sha);
        return object ? [{ sha, commit: { message: parseCommit(object.payload).message } }] : [];
      });
      return sendJson(response, 200, commits);
    }

    if (segments[5] === "contents" && segments.length >= 6 && (method === "GET" || method === "PUT" || method === "DELETE")) {
      const pathParts = segments.slice(6);
      const path = pathParts.join("/");
      if (method !== "GET" && pathParts.length === 0) return notFound();
      if (!repository) return notFound();
      if (method === "GET") {
        const branch = isString(query.get("ref")) ? query.get("ref") : repository.defaultBranch;
        const tip = branchTip(repository, branch);
        if (!tip) return notFound();
        const flat = flatAt(repository, tip);
        const exact = flat.get(path);
        if (exact) {
          const object = getObject(repository, exact.sha);
          if (!object || object.type !== "blob") return notFound();
          const name = pathParts[pathParts.length - 1] ?? "";
          return sendJson(response, 200, {
            type: "file", encoding: "base64", content: encodeBase64(object.payload), sha: exact.sha,
            size: object.payload.length, name, path,
          });
        }
        const prefix = path ? `${path}/` : "";
        const isDirectory = path === "" ? flat.size > 0 : Array.from(flat.keys()).some((key) => key.startsWith(prefix));
        if (!isDirectory) return notFound();
        const children = new Map<string, { type: "file" | "dir"; name: string; path: string; sha: string; size: number }>();
        for (const [key, entry] of flat) {
          if (!key.startsWith(prefix)) continue;
          const remainder = key.slice(prefix.length);
          const slash = remainder.indexOf("/");
          const childName = slash < 0 ? remainder : remainder.slice(0, slash);
          if (!childName || children.has(childName)) continue;
          const childPath = path ? `${path}/${childName}` : childName;
          if (slash < 0) {
            const object = getObject(repository, entry.sha);
            children.set(childName, { type: "file", name: childName, path: childPath, sha: entry.sha, size: object?.payload.length ?? 0 });
          } else {
            const relative = new Map<string, FlatEntry>();
            const childPrefix = `${childPath}/`;
            for (const [nestedPath, nestedEntry] of flat) if (nestedPath.startsWith(childPrefix)) relative.set(nestedPath.slice(childPrefix.length), nestedEntry);
            children.set(childName, { type: "dir", name: childName, path: childPath, sha: buildTreeFromFlatMap(repository, relative), size: 0 });
          }
        }
        return sendJson(response, 200, Array.from(children.values()).sort((a, b) => a.name.localeCompare(b.name)));
      }
      if (method === "PUT") {
        const body = await readObjectBody(request);
        if (!body) return badRequest();
        if (!isString(body.message) || !isString(body.content)) return badRequest();
        const branch = isString(body.branch) ? body.branch : repository.defaultBranch;
        const oldTip = branchTip(repository, branch);
        if (!oldTip && repository.refs.size > 0) return notFound();
        const flat = flatAt(repository, oldTip);
        const current = flat.get(path);
        if (body.sha !== undefined && (!isString(body.sha) || !current || !sameHash(body.sha, current.sha))) return sendJsonError(response, 409, "File SHA does not match");
        const existed = current !== undefined;
        const bytes = decodeBase64(body.content);
        const blobSha = storeObject(repository, "blob", bytes);
        const updated = new Map(flat);
        updated.set(path, { sha: blobSha, mode: "100644" });
        const commitSha = createCommitFromFlat(store, repository, branch, updated, body.message, oldTip);
        return sendJson(response, existed ? 200 : 201, {
          content: { sha: blobSha, encoding: "base64", name: pathParts[pathParts.length - 1], path, size: bytes.length, type: "file" },
          commit: { sha: commitSha },
        });
      }
      const body = await readObjectBody(request);
      if (!body) return badRequest();
      if (!isString(body.message) || !isString(body.sha)) return badRequest();
      const oldTip = branchTip(repository, repository.defaultBranch);
      if (!oldTip) return notFound();
      const flat = flatAt(repository, oldTip);
      const current = flat.get(path);
      if (!current) return notFound();
      if (!sameHash(body.sha, current.sha)) return sendJsonError(response, 409, "File SHA does not match");
      const updated = new Map(flat);
      updated.delete(path);
      const commitSha = createCommitFromFlat(store, repository, repository.defaultBranch, updated, body.message, oldTip);
      return sendJson(response, 200, { commit: { sha: commitSha } });
    }

    if (segments.length === 6 && segments[5] === "labels" && method === "POST") {
      if (!repository) return notFound();
      const body = await readObjectBody(request);
      if (!body) return badRequest();
      if (!isString(body.name) || !body.name) return badRequest();
      const label: Label = { name: body.name, color: isString(body.color) ? body.color : "" };
      repository.labels.set(label.name, label);
      return sendJson(response, 201, { name: label.name, color: label.color });
    }

    if (segments.length === 6 && segments[5] === "issues") {
      if (!repository) return notFound();
      if (method === "POST") {
        const body = await readObjectBody(request);
        if (!body) return badRequest();
        const labels = body.labels === undefined ? [] : body.labels;
        if (!Array.isArray(labels) || labels.some((label) => !isString(label))) return badRequest();
        const issue = createIssue(repository, isString(body.title) ? body.title : "", isString(body.body) ? body.body : "", labels as string[]);
        if (!issue) return sendJsonError(response, 422, "Label not found");
        return sendJson(response, 201, issueView(repository, issue));
      }
      if (method === "GET") {
        let issues = repository.issueOrder.flatMap((number) => {
          const issue = repository.issues.get(number);
          return issue ? [issue] : [];
        });
        const state = query.get("state");
        issues = issues.filter((issue) => state === "all" || (state === "closed" ? issue.state === "closed" : issue.state === "open"));
        const descending = query.get("direction") === "desc";
        issues.sort((a, b) => descending ? b.seq - a.seq : a.seq - b.seq);
        if (isString(query.get("per_page"))) {
          const limit = positiveQuery(query.get("per_page"), 0);
          if (limit > 0) issues = issues.slice(0, limit);
        }
        return sendJson(response, 200, issues.map((issue) => issueView(repository, issue)));
      }
    }

    if (segments.length >= 7 && segments[5] === "issues") {
      const number = issueNumber(segments[6]);
      if (!repository || number === null) return notFound();
      const issue = repository.issues.get(number);
      if (!issue) return notFound();
      if (segments.length === 7 && method === "GET") return sendJson(response, 200, issueView(repository, issue));
      if (segments.length === 7 && method === "PATCH") {
        const body = await readObjectBody(request);
        if (!body) return badRequest();
        if (isString(body.state)) issue.state = body.state;
        if (isString(body.title)) issue.title = body.title;
        if (isString(body.body)) issue.body = body.body;
        return sendJson(response, 200, issueView(repository, issue));
      }
      if (segments.length === 8 && segments[7] === "comments") {
        if (method === "POST") {
          const body = await readObjectBody(request);
          if (!body) return badRequest();
          const commentBody = isString(body.body) ? body.body : "";
          const comment = addComment(store, repository, number, commentBody);
          return sendJson(response, 201, { id: comment.id, body: comment.body });
        }
        if (method === "GET") {
          const comments: Comment[] = repository.commentsByIssue.get(number) ?? [];
          return sendJson(response, 200, comments.map((comment) => ({ id: comment.id, body: comment.body })));
        }
      }
    }

    if (segments.length === 6 && segments[5] === "pulls") {
      if (!repository) return notFound();
      if (method === "POST") {
        const body = await readObjectBody(request);
        if (!body) return badRequest();
        if (!isString(body.head) || !body.head || !isString(body.base) || !body.base) return badRequest();
        const headTip = branchTip(repository, body.head);
        const baseTip = branchTip(repository, body.base);
        if (!headTip || !baseTip) return notFound();
        const pull = createPull(repository, body.head, body.base, headTip, baseTip, isString(body.title) ? body.title : "", isString(body.body) ? body.body : "");
        return sendJson(response, 201, pullView(pull));
      }
      if (method === "GET") {
        let pulls = repository.pullOrder.flatMap((number) => {
          const pull = repository.pulls.get(number);
          return pull ? [pull] : [];
        });
        pulls = pulls.filter((pull) => query.get("state") === "all" || (query.get("state") === "closed" ? pull.state === "closed" : pull.state === "open"));
        if (isString(query.get("per_page"))) {
          const limit = positiveQuery(query.get("per_page"), 0);
          if (limit > 0) pulls = pulls.slice(0, limit);
        }
        return sendJson(response, 200, pulls.map(pullView));
      }
    }

    if (segments.length >= 7 && segments[5] === "pulls") {
      const number = issueNumber(segments[6]);
      if (!repository || number === null) return notFound();
      const pull = repository.pulls.get(number);
      if (!pull) return notFound();
      if (segments.length === 7 && method === "GET") return sendJson(response, 200, pullView(pull));
      if (segments.length === 8 && segments[7] === "files" && method === "GET") {
        const baseFlat = flatAt(repository, pull.baseSha);
        const headFlat = flatAt(repository, pull.headSha);
        const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
        const files = Array.from(paths).sort().flatMap((filename) => {
          const oldEntry = baseFlat.get(filename);
          const newEntry = headFlat.get(filename);
          if (sameHash(oldEntry?.sha, newEntry?.sha)) return [];
          const oldObject = oldEntry ? getObject(repository, oldEntry.sha) : undefined;
          const newObject = newEntry ? getObject(repository, newEntry.sha) : undefined;
          const oldText = oldObject?.payload.toString("utf8") ?? "";
          const newText = newObject?.payload.toString("utf8") ?? "";
          const lines = (value: string) => value === "" ? [] : value.replace(/\n$/, "").split("\n");
          const counts = (value: string) => {
            const result = new Map<string, number>();
            for (const line of lines(value)) result.set(line, (result.get(line) ?? 0) + 1);
            return result;
          };
          const oldCounts = counts(oldText);
          const newCounts = counts(newText);
          const allLines = new Set([...oldCounts.keys(), ...newCounts.keys()]);
          let additions = 0;
          let deletions = 0;
          for (const line of allLines) {
            const oldCount = oldCounts.get(line) ?? 0;
            const newCount = newCounts.get(line) ?? 0;
            if (newCount > oldCount) additions += newCount - oldCount;
            if (oldCount > newCount) deletions += oldCount - newCount;
          }
          return [{ filename, status: !oldEntry ? "added" : !newEntry ? "removed" : "modified", additions, deletions, changes: additions + deletions }];
        });
        return sendJson(response, 200, files);
      }
      if (segments.length === 8 && segments[7] === "merge" && method === "PUT") {
        const body = await readObjectBody(request);
        if (!body) return badRequest();
        if (pull.merged) return sendJsonError(response, 405, "Pull request is already merged");
        const baseTip = branchTip(repository, pull.baseRef);
        const headTip = branchTip(repository, pull.headRef);
        if (!baseTip || !headTip) return notFound();
        const mergeBase = findMergeBase(repository, baseTip, headTip);
        const baseFlat = flatAt(repository, mergeBase ?? undefined);
        const headFlat = flatAt(repository, headTip);
        const currentBaseFlat = flatAt(repository, baseTip);
        const result = new Map<string, FlatEntry>();
        const allPaths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...currentBaseFlat.keys()]);
        let conflict = false;
        for (const path of allPaths) {
          const ancestor = baseFlat.get(path);
          const head = headFlat.get(path);
          const base = currentBaseFlat.get(path);
          const headUnchanged = sameHash(head?.sha, ancestor?.sha);
          const baseUnchanged = sameHash(base?.sha, ancestor?.sha);
          let chosen: FlatEntry | undefined;
          if (headUnchanged) chosen = base;
          else if (baseUnchanged) chosen = head;
          else if (sameHash(head?.sha, base?.sha)) chosen = head;
          else conflict = true;
          if (chosen) result.set(path, chosen);
        }
        if (conflict) return sendJsonError(response, 405, "Merge conflict");
        const tree = buildTreeFromFlatMap(repository, result);
        const identity = fixedIdentityLine(store);
        const payload = buildCommit(tree, [baseTip], identity, identity, pull.title);
        const mergeSha = storeObject(repository, "commit", payload);
        repository.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = "closed";
        pull.merged = true;
        pull.mergedAt = fixedTimestamp();
        pull.mergeCommitSha = mergeSha;
        return sendJson(response, 200, { merged: true, sha: mergeSha, message: "Pull request successfully merged" });
      }
    }
  }

  return notFound();
}

