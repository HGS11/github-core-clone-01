import type { Buffer } from "node:buffer";

export type User = {
  id: number;
  login: string;
  name: string;
  email: string;
};

export type GitObject = {
  type: string;
  payload: Buffer;
};

export type Label = {
  name: string;
  color: string;
};

export type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  labelNames: string[];
  seq: number;
};

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  state: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  seq: number;
};

export type Comment = {
  id: number;
  body: string;
  seq: number;
};

export type Repository = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  nextNumber: number;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  issueOrder: number[];
  pulls: Map<number, PullRequest>;
  pullOrder: number[];
  commentsByIssue: Map<number, Comment[]>;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
};

export type Store = {
  users: User[];
  repos: Map<string, Repository>;
  nextRepoId: number;
  nextCommentId: number;
  nextSeq: number;
};

export const orgLogin = "faint-meadow-org";

const viewerLogin = "adaiversen";
const fixedEpoch = "1735689600";
const fixedTimezone = "+0000";

function fixedUsers(): User[] {
  return [
    { id: 1000, login: "adaiversen", name: "ada iversen", email: "adaiversen@example.invalid" },
    { id: 1001, login: "quinnkeller", name: "quinn keller", email: "quinnkeller@example.invalid" },
    { id: 1002, login: "olgabauer", name: "olga bauer", email: "olgabauer@example.invalid" },
    { id: 1003, login: "dmitriquist", name: "dmitri quist", email: "dmitriquist@example.invalid" },
    { id: 1004, login: "adanovak", name: "ada novak", email: "adanovak@example.invalid" },
    { id: 1005, login: "zanerossi", name: "zane rossi", email: "zanerossi@example.invalid" },
    { id: 1006, login: "pavelcosta", name: "pavel costa", email: "pavelcosta@example.invalid" },
    { id: 1007, login: "wrenkeller", name: "wren keller", email: "wrenkeller@example.invalid" },
    { id: 1008, login: "coraquist", name: "cora quist", email: "coraquist@example.invalid" },
    { id: 1009, login: "elenaulrich", name: "elena ulrich", email: "elenaulrich@example.invalid" },
    { id: 1010, login: "tesssato", name: "tess sato", email: "tesssato@example.invalid" },
    { id: 1011, login: "svenrossi", name: "sven rossi", email: "svenrossi@example.invalid" },
  ];
}

export function createStore(): Store {
  return {
    users: fixedUsers(),
    repos: new Map<string, Repository>(),
    nextRepoId: 1,
    nextCommentId: 1,
    nextSeq: 1,
  };
}

export function createRepository(
  store: Store,
  name: string,
  isPrivate: boolean,
  description: string,
): Repository | null {
  if (store.repos.has(name)) return null;

  const owner = viewerLogin;
  const repository: Repository = {
    id: store.nextRepoId,
    owner,
    name,
    fullName: `${owner}/${name}`,
    description,
    isPrivate,
    defaultBranch: "main",
    seq: store.nextSeq,
    nextNumber: 1,
    labels: new Map<string, Label>(),
    issues: new Map<number, Issue>(),
    issueOrder: [],
    pulls: new Map<number, PullRequest>(),
    pullOrder: [],
    commentsByIssue: new Map<number, Comment[]>(),
    objects: new Map<string, GitObject>(),
    refs: new Map<string, string>(),
  };
  store.nextRepoId += 1;
  store.nextSeq += 1;
  store.repos.set(name, repository);
  return repository;
}

export function findRepository(store: Store, owner: string, name: string): Repository | undefined {
  if (owner !== viewerLogin) return undefined;
  return store.repos.get(name);
}

export function deleteRepository(store: Store, owner: string, name: string): boolean {
  if (owner !== viewerLogin || !store.repos.has(name)) return false;
  store.repos.delete(name);
  return true;
}

export function listRepositories(store: Store): Repository[] {
  return Array.from(store.repos.values()).sort((left, right) => left.seq - right.seq);
}

export function getViewer(store: Store): User {
  return store.users.find((user) => user.id === 1000)!;
}

export function findUserByLogin(store: Store, login: string): User | undefined {
  return store.users.find((user) => user.login === login);
}

export function nextNumber(repository: Repository): number {
  const number = repository.nextNumber;
  repository.nextNumber += 1;
  return number;
}

export function createIssue(
  repository: Repository,
  title: string,
  body: string,
  labelNames: string[],
): Issue | null {
  if (!labelNames.every((name) => repository.labels.has(name))) return null;

  const number = nextNumber(repository);
  const issue: Issue = {
    number,
    title,
    body,
    state: "open",
    labelNames: [...labelNames],
    seq: number,
  };
  repository.issues.set(number, issue);
  repository.issueOrder.push(number);
  return issue;
}

export function createPull(
  repository: Repository,
  headRef: string,
  baseRef: string,
  headSha: string,
  baseSha: string,
  title: string,
  body: string,
): PullRequest {
  const number = nextNumber(repository);
  const pull: PullRequest = {
    number,
    title,
    body,
    state: "open",
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: "",
    mergeCommitSha: "",
    seq: number,
  };
  repository.pulls.set(number, pull);
  repository.pullOrder.push(number);
  return pull;
}

export function addComment(store: Store, repository: Repository, issueNumber: number, body: string): Comment {
  const comment: Comment = {
    id: store.nextCommentId,
    body,
    seq: store.nextSeq,
  };
  store.nextCommentId += 1;
  store.nextSeq += 1;

  const comments = repository.commentsByIssue.get(issueNumber) ?? [];
  comments.push(comment);
  repository.commentsByIssue.set(issueNumber, comments);
  return comment;
}

export function fixedIdentityLine(store: Store): string {
  const viewer = getViewer(store);
  return `${viewer.name} <${viewer.email}> ${fixedEpoch} ${fixedTimezone}`;
}

export function fixedTimestamp(): string {
  return "2025-01-01T00:00:00.000Z";
}
