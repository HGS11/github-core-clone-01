import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  storeObject,
  getObject,
  parseCommit,
  parseTree,
  isAncestor,
  listReachableObjects,
  readPack,
  writePack,
  encodePacketLine,
  decodePacketLines,
  PACKET_LINE_FLUSH,
  PACKET_LINE_DELIM,
} from './gitcore.ts';
import type { PackObject } from './gitcore.ts';
import { findRepository } from './store.ts';
import type { Store, Repository } from './store.ts';
import { readBody, sendJsonError, checkAuth } from './httputil.ts';
import type { ParsedRequestUrl } from './httputil.ts';

interface GitContext {
  token: string;
  url: ParsedRequestUrl;
}

interface PacketRecord {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

interface PeelResult {
  tags: string[];
  finalHash: string | null;
}

interface FetchCacheEntry {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

interface ReceiveCommand {
  oldHash: string;
  newHash: string;
  ref: string;
}

interface ReceiveResult {
  ok: boolean;
  ref: string;
  reason?: string;
}

const zeroHash = '0000000000000000000000000000000000000000';
const fetchCache = new Map<string, Buffer>();

function repositoryFingerprint(repository: Repository): string {
  const refs = [...repository.refs.entries()].sort(([a], [b]) => a.localeCompare(b));
  const objects = [...repository.objects.keys()].sort();
  return JSON.stringify([repository.defaultBranch, refs, objects]);
}

function cacheResponse(key: string, response: Buffer): Buffer {
  if (fetchCache.size > 64) fetchCache.delete(fetchCache.keys().next().value!);
  fetchCache.set(key, response);
  return response;
}

function packetText(text: string): Buffer {
  return encodePacketLine(text);
}

function joinPackets(packets: Buffer[]): Buffer {
  return Buffer.concat(packets);
}

function sideband(bytes: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 65515) {
    const chunkLength = Math.min(65515, bytes.length - offset);
    const total = chunkLength + 5;
    const packet = Buffer.allocUnsafe(total);
    packet.write(total.toString(16).padStart(4, '0'), 0, 4, 'ascii');
    packet[4] = 1;
    bytes.copy(packet, 5, offset, offset + chunkLength);
    packets.push(packet);
  }
  return packets;
}

function peelTags(repository: Repository, startHash: string): PeelResult {
  const tags: string[] = [];
  const seen = new Set<string>();
  let current: string | null = startHash;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const object = getObject(repository, current);
    if (!object) return { tags, finalHash: tags.length ? null : null };
    if (object.type !== 'tag') return { tags, finalHash: current };
    tags.push(current);
    const first = object.payload.toString('utf8').split('\n').find((line) => line.startsWith('object '));
    if (!first) return { tags, finalHash: null };
    current = first.slice(7).trim();
  }
  return { tags, finalHash: null };
}

function treeClosure(repository: Repository, treeHash: string): Set<string> {
  const result = new Set<string>();
  const seen = new Set<string>();
  const work: string[] = [];
  result.add(treeHash);
  seen.add(treeHash);
  work.push(treeHash);
  while (work.length) {
    const hash = work.shift()!;
    const object = getObject(repository, hash);
    if (!object || object.type !== 'tree') continue;
    for (const entry of parseTree(object.payload)) {
      if (entry.mode === '160000') continue;
      result.add(entry.sha);
      if (entry.mode === '40000' && !seen.has(entry.sha)) {
        seen.add(entry.sha);
        work.push(entry.sha);
      }
    }
  }
  return result;
}

function textRecords(records: PacketRecord[]): string[] {
  return records
    .filter((record) => record.kind === 'data')
    .map((record) => record.payload.toString('utf8').replace(/\n+$/, ''));
}

function splitUploadRecords(records: PacketRecord[]): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let sawCommand = false;
  let afterDelim = false;
  for (const record of records) {
    switch (record.kind) {
      case 'data': {
        const line = record.payload.toString('utf8').replace(/\n+$/, '');
        if (!sawCommand) {
          command = line;
          sawCommand = true;
        } else if (afterDelim) {
          args.push(line);
        }
        break;
      }
      case 'delim':
        afterDelim = true;
        break;
      case 'flush':
      case 'end':
        if (record.kind === 'flush') afterDelim = false;
        break;
    }
  }
  return { command, args };
}

function responseBytes(response: ServerResponse, contentType: string, body: Buffer): Promise<void> {
  response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
  response.write(body);
  return new Promise((resolve) => response.end(resolve));
}

function uploadAdvertisement(): Buffer {
  return joinPackets([
    packetText('# service=git-upload-pack\n'),
    Buffer.from(PACKET_LINE_FLUSH),
    packetText('version 2\n'),
    packetText('fetch=shallow\n'),
    packetText('ls-refs=unborn\n'),
    packetText('object-format=sha1\n'),
    Buffer.from(PACKET_LINE_FLUSH),
  ]);
}

function receiveAdvertisement(repository: Repository): Buffer {
  const packets: Buffer[] = [packetText('# service=git-receive-pack\n'), Buffer.from(PACKET_LINE_FLUSH)];
  const capabilities = `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repository.defaultBranch}`;
  const refs = [...repository.refs.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!refs.length) {
    packets.push(packetText(`${zeroHash} capabilities^{}\0${capabilities}\n`));
  } else {
    const headRef = `refs/heads/${repository.defaultBranch}`;
    const headHash = repository.refs.get(headRef) ?? zeroHash;
    packets.push(packetText(`${headHash} HEAD\0${capabilities}\n`));
    for (const [name, hash] of refs) {
      packets.push(packetText(`${hash} ${name}\n`));
      if (name.startsWith('refs/tags/')) {
        const peeled = peelTags(repository, hash);
        if (peeled.tags.length && peeled.finalHash) packets.push(packetText(`${peeled.finalHash} ${name}^{}\n`));
      }
    }
  }
  packets.push(Buffer.from(PACKET_LINE_FLUSH));
  return joinPackets(packets);
}

function refListing(repository: Repository, args: string[]): Buffer {
  const key = JSON.stringify(['refs', repositoryFingerprint(repository), args]);
  const cached = fetchCache.get(key);
  if (cached) return cached;
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11));
  const candidates: Array<{ name: string; line: string }> = [];
  for (const [name, hash] of [...repository.refs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let line = `${hash} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const result = peelTags(repository, hash);
      if (result.tags.length && result.finalHash) line += ` peeled:${result.finalHash}`;
    }
    candidates.push({ name, line });
  }
  if (symrefs) {
    const ref = `refs/heads/${repository.defaultBranch}`;
    const hash = repository.refs.get(ref);
    candidates.push({ name: 'HEAD', line: hash ? `${hash} HEAD symref-target:${ref}` : `unborn HEAD symref-target:${ref}` });
  }
  const packets = candidates
    .filter(({ name }) => !prefixes.length || prefixes.some((prefix) => name.startsWith(prefix)))
    .map(({ line }) => packetText(`${line}\n`));
  packets.push(Buffer.from(PACKET_LINE_FLUSH));
  return cacheResponse(key, joinPackets(packets));
}

function commitBoundaryWalk(repository: Repository, tips: string[], boundaries: Set<string>): Set<string> {
  const result = new Set<string>();
  const queued = new Set<string>();
  const work: string[] = [];
  for (const tip of tips) {
    const peeled = peelTags(repository, tip);
    for (const tag of peeled.tags) result.add(tag);
    if (peeled.finalHash && !queued.has(peeled.finalHash)) {
      queued.add(peeled.finalHash);
      work.push(peeled.finalHash);
    }
  }
  while (work.length) {
    const hash = work.shift()!;
    const object = getObject(repository, hash);
    if (!object || object.type !== 'commit' || result.has(hash)) continue;
    result.add(hash);
    const commit = parseCommit(object.payload);
    for (const treeHash of treeClosure(repository, commit.tree)) result.add(treeHash);
    if (!boundaries.has(hash)) {
      for (const parent of commit.parents) {
        if (!queued.has(parent)) {
          queued.add(parent);
          work.push(parent);
        }
      }
    }
  }
  return result;
}

function shallowFetch(repository: Repository, wants: string[], depth: number): { included: Set<string>; shallow: string[] } {
  const included = new Set<string>();
  const commits = new Map<string, number>();
  const work: Array<{ hash: string; generation: number }> = [];
  for (const want of wants) {
    const peeled = peelTags(repository, want);
    for (const tag of peeled.tags) included.add(tag);
    if (!peeled.finalHash) continue;
    const object = getObject(repository, peeled.finalHash);
    if (!object) continue;
    if (object.type === 'commit') work.push({ hash: peeled.finalHash, generation: 0 });
    else if (object.type === 'tree') for (const hash of treeClosure(repository, peeled.finalHash)) included.add(hash);
    else if (object.type === 'blob') included.add(peeled.finalHash);
  }
  while (work.length) {
    const { hash, generation } = work.shift()!;
    const prior = commits.get(hash);
    if (prior !== undefined && prior <= generation) continue;
    commits.set(hash, generation);
    if (generation >= depth) continue;
    const object = getObject(repository, hash);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.payload);
    for (const parent of commit.parents) work.push({ hash: parent, generation: generation + 1 });
  }
  for (const [hash, generation] of commits) {
    if (generation >= depth) continue;
    const object = getObject(repository, hash);
    if (!object || object.type !== 'commit') continue;
    included.add(hash);
    const commit = parseCommit(object.payload);
    for (const treeHash of treeClosure(repository, commit.tree)) included.add(treeHash);
  }
  const shallow = [...commits.keys()].filter((hash) => {
    if (!included.has(hash)) return false;
    const object = getObject(repository, hash);
    if (!object || object.type !== 'commit') return false;
    return parseCommit(object.payload).parents.some((parent) => getObject(repository, parent) && !included.has(parent));
  }).sort();
  return { included, shallow };
}

function fetchResult(repository: Repository, wants: string[], haves: string[], requestShallow: string[], depth?: number): FetchCacheEntry {
  const held = commitBoundaryWalk(repository, haves, new Set(requestShallow));
  let send: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth === undefined) {
    send = new Set(listReachableObjects(repository, wants));
  } else {
    const limited = shallowFetch(repository, wants, depth);
    send = limited.included;
    shallow = limited.shallow;
    unshallow = requestShallow.filter((hash) => {
      if (!send.has(hash)) return false;
      const object = getObject(repository, hash);
      if (!object || object.type !== 'commit') return false;
      return parseCommit(object.payload).parents.every((parent) => !getObject(repository, parent) || send.has(parent));
    });
  }
  for (const hash of held) send.delete(hash);
  const objects: PackObject[] = [];
  for (const hash of [...send].sort()) {
    const object = getObject(repository, hash);
    if (object) objects.push(object);
  }
  const entry = { pack: writePack(objects), shallow: shallow.sort(), unshallow: unshallow.sort() };
  return entry;
}

function fetchResponse(repository: Repository, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const requestShallow: string[] = [];
  let depth: number | undefined;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) requestShallow.push(line.slice(8).split(' ')[0]);
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7));
      if (Number.isFinite(value) && value > 0) depth = Math.floor(value);
    }
  }
  const key = JSON.stringify(['fetch', repositoryFingerprint(repository), [...wants].sort(), [...haves].sort(), [...requestShallow].sort(), depth ?? null]);
  const cached = fetchCache.get(key);
  if (cached) return cached;
  const result = fetchResult(repository, wants, haves, requestShallow, depth);
  const storedHaves = haves.filter((hash) => getObject(repository, hash));
  const packets: Buffer[] = [];
  if (haves.length) {
    packets.push(packetText('acknowledgments\n'));
    if (!storedHaves.length) packets.push(packetText('NAK\n'));
    else for (const hash of storedHaves) packets.push(packetText(`ACK ${hash}\n`));
    packets.push(packetText('ready\n'), Buffer.from(PACKET_LINE_DELIM));
  }
  if (depth !== undefined && (result.shallow.length || result.unshallow.length)) {
    packets.push(packetText('shallow-info\n'));
    for (const hash of result.shallow) packets.push(packetText(`shallow ${hash}\n`));
    for (const hash of result.unshallow) packets.push(packetText(`unshallow ${hash}\n`));
    packets.push(Buffer.from(PACKET_LINE_DELIM));
  }
  packets.push(packetText('packfile\n'), ...sideband(result.pack), Buffer.from(PACKET_LINE_FLUSH));
  return cacheResponse(key, joinPackets(packets));
}

function receiveLines(body: Buffer): { lines: string[]; offset: number; valid: boolean } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') return { lines, offset: offset + 4, valid: true };
    if (!/^[0-9a-f]{4}$/.test(header)) return { lines: [], offset: body.length, valid: false };
    const length = Number.parseInt(header, 16);
    if (length < 4 || offset + length > body.length) return { lines: [], offset: body.length, valid: false };
    const payload = body.subarray(offset + 4, offset + length);
    lines.push(payload.toString('utf8').replace(/\n$/, '').split('\0', 1)[0]);
    offset += length;
  }
  return { lines: [], offset: body.length, valid: false };
}

function receiveResponse(repository: Repository, body: Buffer): Buffer {
  const parsed = receiveLines(body);
  const commands: ReceiveCommand[] = parsed.valid
    ? parsed.lines.map((line) => line.split(' ')).filter((parts) => parts.length === 3).map(([oldHash, newHash, ref]) => ({ oldHash, newHash, ref }))
    : [];
  let unpackOk = parsed.valid;
  if (commands.length && unpackOk) {
    const packBytes = body.subarray(parsed.offset);
    if (packBytes.length) {
      try {
        for (const object of readPack(repository, packBytes)) storeObject(repository, object.type, object.payload);
      } catch {
        unpackOk = false;
      }
    }
  }
  const results: ReceiveResult[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ok: false, ref: command.ref, reason: 'unpack failed' });
      continue;
    }
    const current = repository.refs.get(command.ref);
    if (command.newHash === zeroHash) {
      repository.refs.delete(command.ref);
      results.push({ ok: true, ref: command.ref });
    } else if (command.newHash === current) {
      results.push({ ok: true, ref: command.ref });
    } else if (current === undefined) {
      if (command.oldHash === zeroHash) {
        repository.refs.set(command.ref, command.newHash);
        results.push({ ok: true, ref: command.ref });
      } else results.push({ ok: false, ref: command.ref, reason: 'non-fast-forward' });
    } else if (command.oldHash === current && isAncestor(repository, command.oldHash, command.newHash)) {
      repository.refs.set(command.ref, command.newHash);
      results.push({ ok: true, ref: command.ref });
    } else results.push({ ok: false, ref: command.ref, reason: 'non-fast-forward' });
  }
  const report: Buffer[] = [packetText(unpackOk ? 'unpack ok\n' : 'unpack pack rejected\n')];
  for (const result of results) report.push(packetText(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  report.push(Buffer.from(PACKET_LINE_FLUSH));
  return joinPackets([...sideband(joinPackets(report)), Buffer.from(PACKET_LINE_FLUSH)]);
}

export async function handleGitRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: Store,
  context: GitContext,
): Promise<void> {
  try {
    const segments = context.url.segments;
    if (segments.length < 3 || !segments[1].endsWith('.git')) {
      sendJsonError(response, 404, 'Not Found');
      return;
    }
    const owner = segments[0];
    const repositoryName = segments[1].slice(0, -4);
    const tail = segments.slice(2);
    const isInfo = tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs';
    const isUpload = tail.length === 1 && tail[0] === 'git-upload-pack';
    const isReceive = tail.length === 1 && tail[0] === 'git-receive-pack';
    if (!isInfo && !isUpload && !isReceive) {
      sendJsonError(response, 404, 'Not Found');
      return;
    }
    if ((isInfo && request.method !== 'GET') || ((isUpload || isReceive) && request.method !== 'POST')) {
      sendJsonError(response, 404, 'Not Found');
      return;
    }
    if (!checkAuth(request, context.token)) {
      sendJsonError(response, 401, 'Unauthorized');
      return;
    }
    const repository = findRepository(store, owner, repositoryName);
    if (!repository) {
      sendJsonError(response, 404, 'Not Found');
      return;
    }
    if (isInfo) {
      const service = context.url.query.get('service');
      if (service === 'git-upload-pack') {
        await responseBytes(response, 'application/x-git-upload-pack-advertisement', uploadAdvertisement());
        return;
      }
      if (service === 'git-receive-pack') {
        await responseBytes(response, 'application/x-git-receive-pack-advertisement', receiveAdvertisement(repository));
        return;
      }
      sendJsonError(response, 404, 'Not Found');
      return;
    }
    const body = await readBody(request);
    if (isUpload) {
      let records: PacketRecord[];
      try {
        records = decodePacketLines(body) as PacketRecord[];
      } catch {
        sendJsonError(response, 400, 'Bad Request');
        return;
      }
      const { command, args } = splitUploadRecords(records);
      if (command === 'command=ls-refs') {
        await responseBytes(response, 'application/x-git-upload-pack-result', refListing(repository, args));
        return;
      }
      if (command === 'command=fetch') {
        await responseBytes(response, 'application/x-git-upload-pack-result', fetchResponse(repository, args));
        return;
      }
      await responseBytes(response, 'application/x-git-upload-pack-result', Buffer.from(PACKET_LINE_FLUSH));
      return;
    }
    await responseBytes(response, 'application/x-git-receive-pack-result', receiveResponse(repository, body));
  } catch {
    if (!response.headersSent && !response.writableEnded) sendJsonError(response, 400, 'Bad Request');
    else if (!response.writableEnded) response.end();
  }
}
