import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, constants as zlibConstants } from 'node:zlib';

export interface GitRepository {
  objects: Map<string, StoredObject>;
}

export interface StoredObject {
  type: string;
  payload: Buffer;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface FlatEntry {
  sha: string;
  mode: string;
}

export interface PackObject {
  type: string;
  payload: Buffer;
}

export interface DecodedPacketLine {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

const ZERO_HASH = '0000000000000000000000000000000000000000';
const DIR_MODE = '40000';
const GITLINK_MODE = '160000';
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export const PACKET_LINE_FLUSH = Buffer.from('0000', 'ascii');
export const PACKET_LINE_DELIM = Buffer.from('0001', 'ascii');
export const PACKET_LINE_RESPONSE_END = Buffer.from('0002', 'ascii');

function objectFrame(type: string, payload: Buffer): Buffer {
  return Buffer.concat([utf8.encode(`${type} ${payload.length}\0`), payload]);
}

export function hashObject(type: string, payload: Buffer): string {
  return createHash('sha1').update(objectFrame(type, payload)).digest('hex');
}

export function storeObject(repository: GitRepository, type: string, payload: Buffer): string {
  const hash = hashObject(type, payload);
  if (!repository.objects.has(hash)) repository.objects.set(hash, { type, payload });
  return hash;
}

export function getObject(repository: GitRepository, hash: string): StoredObject | undefined {
  return repository.objects.get(hash);
}

export function parseCommit(payload: Buffer): ParsedCommit {
  const bytes = payload.indexOf(Buffer.from('\n\n'));
  const headerBytes = bytes < 0 ? payload : payload.subarray(0, bytes);
  const message = bytes < 0 ? '' : utf8Decoder.decode(payload.subarray(bytes + 2));
  const headers = utf8Decoder.decode(headerBytes).split('\n');
  let tree = ZERO_HASH;
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of headers) {
    if (line.startsWith(' ')) continue;
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const headers = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${author}`, `committer ${committer}`, ''].join('\n');
  return Buffer.concat([utf8.encode(`${headers}\n`), utf8.encode(message)]);
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = payload.indexOf(0, space + 1);
    if (nul < 0 || payload.length - nul - 1 < 20) break;
    const mode = payload.toString('ascii', offset, space);
    const name = utf8Decoder.decode(payload.subarray(space + 1, nul));
    const sha = payload.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function compareBytes(a: Buffer, b: Buffer): number {
  const size = Math.min(a.length, b.length);
  for (let i = 0; i < size; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = Buffer.concat([utf8.encode(a.name), a.mode === DIR_MODE ? Buffer.from('/') : Buffer.alloc(0)]);
    const right = Buffer.concat([utf8.encode(b.name), b.mode === DIR_MODE ? Buffer.from('/') : Buffer.alloc(0)]);
    return compareBytes(left, right);
  });
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(utf8.encode(`${entry.mode} `), utf8.encode(entry.name), Buffer.from([0]), Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(chunks);
}

export function flattenTree(repository: GitRepository, treeHash: string): Map<string, FlatEntry> {
  const flat = new Map<string, FlatEntry>();
  const stack: Array<{ hash: string; prefix: string }> = [{ hash: treeHash, prefix: '' }];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current.hash)) continue;
    seen.add(current.hash);
    const object = repository.objects.get(current.hash);
    if (!object || object.type !== 'tree') continue;
    for (const entry of parseTree(object.payload)) {
      if (entry.mode === GITLINK_MODE) continue;
      const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      if (entry.mode === DIR_MODE) stack.push({ hash: entry.sha, prefix: path });
      else flat.set(path, { sha: entry.sha, mode: entry.mode });
    }
  }
  return flat;
}

export function buildTreeFromFlatMap(repository: GitRepository, flat: Map<string, FlatEntry>): string {
  type Node = { children: Map<string, Node>; leaf?: FlatEntry };
  const root: Node = { children: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      let child = node.children.get(part);
      if (!child) { child = { children: new Map() }; node.children.set(part, child); }
      node = child;
      if (i === parts.length - 1) node.leaf = entry;
    }
  }
  const order: Node[] = [root];
  const postorder: Node[] = [];
  while (order.length) {
    const node = order.pop()!;
    postorder.push(node);
    for (const child of node.children.values()) order.push(child);
  }
  const hashes = new Map<Node, string>();
  for (let i = postorder.length - 1; i >= 0; i -= 1) {
    const node = postorder[i];
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.children) {
      if (child.children.size) entries.push({ mode: DIR_MODE, name, sha: hashes.get(child)! });
      else if (child.leaf) entries.push({ mode: child.leaf.mode, name, sha: child.leaf.sha });
    }
    hashes.set(node, storeObject(repository, 'tree', buildTree(entries)));
  }
  return hashes.get(root)!;
}

export function listAncestors(repository: GitRepository, commitHash: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const stack = [commitHash];
  while (stack.length) {
    const hash = stack.pop()!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const object = repository.objects.get(hash);
    if (!object || object.type !== 'commit') continue;
    result.push(hash);
    const parents = parseCommit(object.payload).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return result;
}

export function isAncestor(repository: GitRepository, candidate: string, commitHash: string): boolean {
  if (candidate === commitHash) return true;
  const seen = new Set<string>();
  const stack = [commitHash];
  while (stack.length) {
    const hash = stack.pop()!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const object = repository.objects.get(hash);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.payload).parents) {
      if (parent === candidate) return true;
      stack.push(parent);
    }
  }
  return false;
}

export function findMergeBase(repository: GitRepository, first: string, second: string): string | null {
  if (first === second) return first;
  const collect = (start: string): Set<string> => {
    const found = new Set<string>();
    const queue = [start];
    for (let i = 0; i < queue.length; i += 1) {
      const hash = queue[i];
      if (found.has(hash)) continue;
      const object = repository.objects.get(hash);
      if (!object || object.type !== 'commit') continue;
      found.add(hash);
      queue.push(...parseCommit(object.payload).parents);
    }
    return found;
  };
  const firstSet = collect(first);
  const seen = new Set<string>();
  const queue = [second];
  for (let i = 0; i < queue.length; i += 1) {
    const hash = queue[i];
    if (seen.has(hash)) continue;
    seen.add(hash);
    const object = repository.objects.get(hash);
    if (!object || object.type !== 'commit') continue;
    if (firstSet.has(hash)) return hash;
    queue.push(...parseCommit(object.payload).parents);
  }
  return null;
}

export function encodePacketLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(utf8.encode(payload)) : payload;
  const total = body.length + 4;
  if (total > 65520) throw new Error('packet line too long');
  return Buffer.concat([Buffer.from(total.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function decodePacketLines(bytes: Buffer): DecodedPacketLine[] {
  const lines: DecodedPacketLine[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) throw new Error('truncated packet header');
    const header = bytes.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid packet header');
    offset += 4;
    if (header === '0000') { lines.push({ kind: 'flush', payload: Buffer.alloc(0) }); continue; }
    if (header === '0001') { lines.push({ kind: 'delim', payload: Buffer.alloc(0) }); continue; }
    if (header === '0002') { lines.push({ kind: 'end', payload: Buffer.alloc(0) }); continue; }
    if (header === '0003') throw new Error('invalid packet marker');
    const length = Number.parseInt(header, 16);
    if (length < 4 || length > 65520) throw new Error('invalid packet length');
    const payloadLength = length - 4;
    if (bytes.length - offset < payloadLength) throw new Error('truncated packet payload');
    lines.push({ kind: 'data', payload: bytes.subarray(offset, offset + payloadLength) });
    offset += payloadLength;
  }
  return lines;
}

export function listReachableObjects(repository: GitRepository, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const work = [...tips];
  while (work.length) {
    const hash = work.pop()!;
    if (seen.has(hash)) continue;
    const object = repository.objects.get(hash);
    if (!object) continue;
    seen.add(hash);
    if (object.type === 'commit') {
      const commit = parseCommit(object.payload);
      work.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.payload)) if (entry.mode !== GITLINK_MODE) work.push(entry.sha);
    } else if (object.type === 'tag') {
      const header = utf8Decoder.decode(object.payload).split('\n').find((line) => line.startsWith('object '));
      if (header) work.push(header.slice(7));
    }
  }
  return seen;
}

type ParsedPackEntry = {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseHash?: string;
};

function readPackVarint(bytes: Buffer, state: { offset: number }, initial?: number): number {
  let value = initial ?? 0;
  let shift = initial === undefined ? 0 : 4;
  let byte = initial;
  if (byte === undefined) {
    if (state.offset >= bytes.length) throw new Error('truncated variable integer');
    byte = bytes[state.offset++];
    value = byte & 0x7f;
    shift = 7;
    while (byte & 0x80) {
      if (state.offset >= bytes.length || shift > 49) throw new Error('invalid variable integer');
      byte = bytes[state.offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return value;
  }
  while (byte & 0x80) {
    if (state.offset >= bytes.length || shift > 49) throw new Error('invalid object size');
    byte = bytes[state.offset++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return value;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const state = { offset: 0 };
  const sourceSize = readPackVarint(delta, state);
  const targetSize = readPackVarint(delta, state);
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (state.offset < delta.length && produced < targetSize) {
    const opcode = delta[state.offset++];
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if (opcode & (1 << bit)) {
        if (state.offset >= delta.length) throw new Error('truncated delta copy');
        offset += delta[state.offset++] * 2 ** (8 * bit);
      }
      for (let bit = 0; bit < 3; bit += 1) if (opcode & (1 << (bit + 4))) {
        if (state.offset >= delta.length) throw new Error('truncated delta copy');
        size += delta[state.offset++] * 2 ** (8 * bit);
      }
      if (size === 0) size = 65536;
      if (offset + size > base.length || produced + size > targetSize) throw new Error('delta copy out of range');
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else {
      if (opcode === 0) throw new Error('invalid delta opcode');
      if (state.offset + opcode > delta.length || produced + opcode > targetSize) throw new Error('truncated delta insert');
      chunks.push(delta.subarray(state.offset, state.offset + opcode));
      state.offset += opcode;
      produced += opcode;
    }
  }
  if (produced !== targetSize || state.offset !== delta.length) throw new Error('delta target size mismatch');
  return Buffer.concat(chunks, targetSize);
}

function inflatePackStream(bytes: Buffer, start: number, end: number): { data: Buffer; length: number } {
  const remaining = end - start;
  let failure = 0;
  let success = remaining;
  try { inflateSync(bytes.subarray(start, end)); }
  catch { throw new Error('invalid compressed pack entry'); }
  while (success - failure > 1) {
    const middle = Math.floor((failure + success) / 2);
    try { inflateSync(bytes.subarray(start, start + middle)); success = middle; }
    catch { failure = middle; }
  }
  return { data: inflateSync(bytes.subarray(start, start + success)), length: success };
}

export function readPack(repository: GitRepository | null, pack: Buffer): PackObject[] {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const checksum = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!checksum.equals(pack.subarray(trailerStart))) throw new Error('bad pack checksum');
  const entries: ParsedPackEntry[] = [];
  const offsetEntries = new Map<number, ParsedPackEntry>();
  const state = { offset: 12 };
  while (state.offset < trailerStart) {
    if (entries.length >= count) throw new Error('pack object count mismatch');
    const entryOffset = state.offset;
    const first = pack[state.offset++];
    const typeCode = (first >> 4) & 7;
    if (![1, 2, 3, 4, 6, 7].includes(typeCode)) throw new Error('invalid pack type code');
    let size = first & 15;
    let shift = 4;
    let headerByte = first;
    while (headerByte & 0x80) {
      if (state.offset >= trailerStart || shift > 49) throw new Error('invalid object size header');
      headerByte = pack[state.offset++];
      size += (headerByte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: ParsedPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (state.offset >= trailerStart) throw new Error('truncated offset delta');
      let byte = pack[state.offset++];
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        if (state.offset >= trailerStart) throw new Error('truncated offset delta');
        byte = pack[state.offset++];
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      if (distance <= 0 || distance > entryOffset) throw new Error('invalid offset delta base');
      entry.baseOffset = entryOffset - distance;
    } else if (typeCode === 7) {
      if (state.offset + 20 > trailerStart) throw new Error('truncated reference delta');
      entry.baseHash = pack.subarray(state.offset, state.offset + 20).toString('hex');
      state.offset += 20;
    }
    const inflated = inflatePackStream(pack, state.offset, trailerStart);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    state.offset += inflated.length;
    entries.push(entry);
    offsetEntries.set(entry.offset, entry);
  }
  if (state.offset !== trailerStart || entries.length !== count) throw new Error('pack object count mismatch');
  const resolved = new Map<ParsedPackEntry, PackObject>();
  const resolving = new Set<ParsedPackEntry>();
  const hashes = new Map<string, ParsedPackEntry>();
  const baseTypes = new Map<number, string>([[1, 'commit'], [2, 'tree'], [3, 'blob'], [4, 'tag']]);
  const resolve = (entry: ParsedPackEntry): PackObject => {
    const cached = resolved.get(entry);
    if (cached) return cached;
    if (resolving.has(entry)) throw new Error('delta cycle');
    resolving.add(entry);
    let object: PackObject;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      object = { type: baseTypes.get(entry.typeCode)!, payload: entry.data };
    } else {
      let base: PackObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = offsetEntries.get(entry.baseOffset!);
        if (baseEntry) base = resolve(baseEntry);
      } else {
        const packBase = hashes.get(entry.baseHash!);
        if (packBase) base = resolve(packBase);
        else {
          const stored = repository?.objects.get(entry.baseHash!);
          if (stored) base = { type: stored.type, payload: stored.payload };
        }
      }
      if (!base) throw new Error('delta base not found');
      object = { type: base.type, payload: applyDelta(base.payload, entry.data) };
    }
    resolving.delete(entry);
    resolved.set(entry, object);
    hashes.set(hashObject(object.type, object.payload), entry);
    return object;
  };
  return entries.map(resolve);
}

function encodePackSize(typeCode: number, size: number): Buffer {
  const output: number[] = [];
  let first = (typeCode << 4) | (size & 15);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  output.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    output.push(byte);
  }
  return Buffer.from(output);
}

export function writePack(objects: PackObject[]): Buffer {
  const codes = new Map<string, number>([['commit', 1], ['tree', 2], ['blob', 3], ['tag', 4]]);
  const chunks: Buffer[] = [];
  for (const object of objects) {
    const code = codes.get(object.type);
    if (code === undefined) throw new Error('unsupported pack object type');
    chunks.push(encodePackSize(code, object.payload.length));
    chunks.push(deflateSync(object.payload, { level: zlibConstants.Z_BEST_SPEED }));
  }
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const body = Buffer.concat([header, ...chunks]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
