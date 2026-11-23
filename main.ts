// mend: one patch tool for every AI edit format. It applies a unified diff, SEARCH/REPLACE blocks, a V4A patch or
// JSON text-editor edits to the tree of text files rooted at the working directory, as SPEC.md (version 1) says:
// every change is written or none is. Node 22 and its standard library alone; run it as
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this file hands over to the kit's
// runner.ts (the last lines below), which runs this same file once per check without that variable.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

type Format = 'unified' | 'search-replace' | 'v4a' | 'json';
const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Exit 2: the patch cannot be read in its format; `line` is the 1-based patch line to name. */
class ParseError {
  line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class EditFailure {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Text, lines and paths (SPEC.md section 3)

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  for (let i = 0; i < out.length; i += 1) {
    const s = out[i]!;
    if (s.endsWith('\r')) out[i] = s.slice(0, -1);
  }
  return out;
}

/** A file as lines: its line break, its lines and whether it ends with a break. */
interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}

function toDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function fromDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** The text of a file an edit creates: LF breaks, ended by one unless `final` is false. */
function newFileText(lines: string[], final: boolean): string {
  return fromDoc({ br: '\n', lines, final });
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) if (seg === '' || seg === '.' || seg === '..') return false;
  return true;
}

function requireSafe(...paths: string[]): void {
  for (const p of paths) if (!isSafe(p)) throw new EditFailure('unsafe', p);
}

// ---------------------------------------------------------------------------------------------------------------
// The tree: what is on disk, what the committed edits made of it, and one edit's staged changes on top.

class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly current = new Map<string, string | null>();

  /** The file's text before the patch, or null when there is no such file. */
  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let text: string | null = null;
      try {
        if (statSync(p).isFile()) text = readFileSync(p, 'utf8');
      } catch {
        text = null;
      }
      this.disk.set(p, text);
    }
    return this.disk.get(p)!;
  }

  now(p: string): string | null {
    return this.current.has(p) ? this.current.get(p)! : this.before(p);
  }
}

/** One edit's view of the tree: reads see the edits before it, writes stay staged until the edit succeeds. */
class Stage {
  readonly tree: Tree;
  readonly staged = new Map<string, string | null>();
  constructor(tree: Tree) {
    this.tree = tree;
  }
  get(p: string): string | null {
    return this.staged.has(p) ? this.staged.get(p)! : this.tree.now(p);
  }
  set(p: string, text: string | null): void {
    this.staged.set(p, text);
  }
}

/** An edit applies itself to a stage, throwing EditFailure; a move answers its [old, new] pair. */
type Edit = (stage: Stage) => [string, string] | void;

// ---------------------------------------------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5)

const trimRight = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const TIER_NORMS: Array<(s: string) => string> = [(s) => s, trimRight, trimBoth];
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

interface Found {
  tier: number;
  positions: number[];
}

/** Every position (accepted by `ok`) where `old` occurs in `lines`, at the first tier with at least one. */
function findLines(lines: string[], old: string[], strict: boolean, ok: (pos: number) => boolean = () => true): Found | null {
  const tiers = strict ? 1 : 3;
  for (let tier = 0; tier < tiers; tier += 1) {
    const norm = TIER_NORMS[tier]!;
    const want = old.map(norm);
    const have = lines.map(norm);
    const positions: number[] = [];
    for (let pos = 0; pos + want.length <= have.length; pos += 1) {
      if (!ok(pos)) continue;
      let all = true;
      for (let j = 0; j < want.length; j += 1) {
        if (have[pos + j] !== want[j]) {
          all = false;
          break;
        }
      }
      if (all) positions.push(pos);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A line of N: its text, and for a context line the index of the same line in O (else -1). */
interface NewLine {
  text: string;
  ctx: number;
}

/** `lines` with O's k lines at `pos` replaced by N, as matched at `tier`. */
function replaceLines(lines: string[], pos: number, oldCount: number, old: string[], neu: NewLine[], tier: number): string[] {
  let written: string[];
  if (tier === 2 && oldCount > 0) {
    const fileIndent = leadingWs(lines[pos]!);
    const patchIndent = leadingWs(old[0]!);
    written = neu.map((n) => {
      if (n.ctx >= 0) return lines[pos + n.ctx]!;
      if (isBlank(n.text) || !n.text.startsWith(patchIndent)) return n.text;
      return fileIndent + n.text.slice(patchIndent.length);
    });
  } else {
    written = neu.map((n) => (n.ctx >= 0 ? lines[pos + n.ctx]! : n.text));
  }
  return [...lines.slice(0, pos), ...written, ...lines.slice(pos + oldCount)];
}

// ---------------------------------------------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4)

function detectFormat(lines: string[]): Format | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  const head = lines[first]!;
  if (head.trim() === '*** Begin Patch') return 'v4a';
  const c = head.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)

interface BodyLine {
  kind: string; // ' ', '-', '+' or '\\'
  text: string;
}

interface Hunk {
  start: number; // A of @@ -A[,B] +C[,D] @@
  body: BodyLine[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  hasPair: boolean;
  pairOld?: string | null; // null: /dev/null
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newMode: boolean;
  deletedMode: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** The two paths of `diff --git a/<X> b/<Y>`, or null when the line is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length).trimEnd();
  if (!rest.startsWith('a/')) return null;
  // Same path on both sides (the usual case, and the only safe reading of a path with " b/" in it).
  if ((rest.length - 5) % 2 === 0 && rest.length > 5) {
    const half = (rest.length - 5) / 2;
    const x = rest.slice(2, 2 + half);
    if (rest.slice(2 + half, 5 + half) === ' b/' && rest.slice(5 + half) === x) return [x, x];
  }
  const cut = rest.indexOf(' b/', 2);
  if (cut < 0) return null;
  const x = rest.slice(2, cut);
  const y = rest.slice(cut + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

/** The path of a `--- ` or `+++ ` line: up to the first tab, trimmed, /dev/null as null, one a/ or b/ removed. */
function pairPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ');
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  const open = (): Section => {
    const s: Section = { hasPair: false, newMode: false, deletedMode: false, hunks: [] };
    sections.push(s);
    inHeader = true;
    return s;
  };

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const paths = gitPaths(line);
      if (paths === null) throw new ParseError(i + 1);
      sec = open();
      sec.gitOld = paths[0];
      sec.gitNew = paths[1];
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (sec === null || !inHeader || sec.hasPair) sec = open();
      sec.hasPair = true;
      sec.pairOld = pairPath(line);
      sec.pairNew = pairPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEADER.exec(line);
      if (m === null || sec === null) throw new ParseError(i + 1);
      inHeader = false;
      const body: BodyLine[] = [];
      let emptyTail = 0; // how many raw empty lines end the body so far
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || pairAt(j)) break;
        if (b === '') {
          body.push({ kind: ' ', text: '' });
          emptyTail += 1;
        } else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push({ kind: b[0], text: b.slice(1) });
          emptyTail = 0;
        } else break;
        j += 1;
      }
      body.length -= emptyTail;
      sec.hunks.push({ start: Number(m[1]), body });
      i = j;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new ParseError(i + 2);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newMode = true;
      else if (line.startsWith('deleted file mode')) sec.deletedMode = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Whether the body line after the last context or `+` line of a hunk is a `\` line. */
function hunkEndsWithoutBreak(body: BodyLine[], kinds: string): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k += 1) if (kinds.includes(body[k]!.kind)) last = k;
  return last >= 0 && body[last + 1]?.kind === '\\';
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  if (sec.hasPair) {
    oldPath = sec.pairOld;
    newPath = sec.pairNew;
  } else if (sec.renameFrom !== undefined || sec.renameTo !== undefined) {
    oldPath = sec.renameFrom ?? sec.gitOld;
    newPath = sec.renameTo ?? sec.gitNew;
  } else {
    oldPath = sec.gitOld;
    newPath = sec.gitNew;
  }
  const creation = oldPath === null || sec.newMode;
  const deletion = !creation && (newPath === null || sec.deletedMode);

  if (creation) {
    const path = newPath ?? sec.gitNew ?? oldPath ?? '';
    const added: string[] = [];
    let final = true;
    for (const h of sec.hunks) {
      for (const b of h.body) if (b.kind === '+') added.push(b.text);
      if (h.body.some((b) => b.kind === '+')) final = !hunkEndsWithoutBreak(h.body, '+');
    }
    return (stage) => {
      requireSafe(path);
      if (stage.get(path) !== null) throw new EditFailure('exists', path);
      stage.set(path, newFileText(added, final));
    };
  }

  if (deletion) {
    const path = oldPath ?? sec.gitOld ?? '';
    return (stage) => {
      requireSafe(path);
      if (stage.get(path) === null) throw new EditFailure('missing', path);
      stage.set(path, null);
    };
  }

  const from = oldPath ?? newPath ?? '';
  const to = newPath ?? from;
  const move = from !== to;
  return (stage) => {
    requireSafe(from, to);
    const text = stage.get(from);
    if (text === null) throw new EditFailure('missing', from);
    if (move && stage.get(to) !== null) throw new EditFailure('exists', to);
    const doc = toDoc(text);
    let lines = doc.lines;
    let final = doc.final;
    let drift = 0;
    for (const h of sec.hunks) {
      const old: string[] = [];
      const neu: NewLine[] = [];
      for (const b of h.body) {
        if (b.kind === ' ') {
          neu.push({ text: b.text, ctx: old.length });
          old.push(b.text);
        } else if (b.kind === '-') old.push(b.text);
        else if (b.kind === '+') neu.push({ text: b.text, ctx: -1 });
      }
      const noBreak = hunkEndsWithoutBreak(h.body, ' +');
      if (old.length === 0) {
        const at = Math.max(0, Math.min(h.start + drift, lines.length));
        if (at === lines.length) final = !noBreak;
        lines = [...lines.slice(0, at), ...neu.map((x) => x.text), ...lines.slice(at)];
      } else {
        const found = findLines(lines, old, strict);
        if (found === null) throw new EditFailure('no-match', from);
        const target = h.start - 1 + drift;
        let pos = found.positions[0]!;
        for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        if (pos + old.length === lines.length) final = !noBreak;
        lines = replaceLines(lines, pos, old.length, old, neu, found.tier);
      }
      drift += neu.length - old.length;
    }
    const out = fromDoc({ br: doc.br, lines, final });
    if (move) {
      stage.set(from, null);
      stage.set(to, out);
      return [from, to];
    }
    stage.set(from, out);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)

const marker = (line: string, m: string): boolean => line.trimEnd() === m;

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastPath: string | null = null;
  let afterBlock = 0; // the first line after the previous block's REPLACE line
  for (let i = 0; i < lines.length; i += 1) {
    if (!marker(lines[i]!, '<<<<<<< SEARCH')) continue;
    let eq = i + 1;
    while (eq < lines.length && !marker(lines[eq]!, '=======')) eq += 1;
    let end = eq + 1;
    while (end < lines.length && !marker(lines[end]!, '>>>>>>> REPLACE')) end += 1;
    if (eq >= lines.length || end >= lines.length) throw new ParseError(i + 1);

    let path: string | null = null;
    for (let p = i - 1; p >= afterBlock; p -= 1) {
      const t = lines[p]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = lastPath;
    if (path === null) throw new ParseError(i + 1);

    edits.push(searchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, end), strict));
    lastPath = path;
    afterBlock = end + 1;
    i = end;
  }
  return edits;
}

function searchReplaceEdit(path: string, old: string[], neu: string[], strict: boolean): Edit {
  return (stage) => {
    requireSafe(path);
    const text = stage.get(path);
    if (old.length === 0) {
      if (text !== null) throw new EditFailure('exists', path);
      stage.set(path, newFileText(neu, true));
      return;
    }
    if (text === null) throw new EditFailure('missing', path);
    const doc = toDoc(text);
    const found = findLines(doc.lines, old, strict);
    if (found === null) throw new EditFailure('no-match', path);
    if (found.positions.length > 1) throw new EditFailure('ambiguous', path);
    const lines = replaceLines(doc.lines, found.positions[0]!, old.length, old, neu.map((t) => ({ text: t, ctx: -1 })), found.tier);
    stage.set(path, fromDoc({ ...doc, lines }));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  // Split the lines between Begin and End into sections: [header index, body indices].
  const sections: Array<{ head: number; body: number[] }> = [];
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (l.startsWith(ADD) || l.startsWith(DELETE) || l.startsWith(UPDATE)) sections.push({ head: i, body: [] });
    else if (sections.length > 0) sections[sections.length - 1]!.body.push(i);
    else if (!isBlank(l)) throw new ParseError(i + 1);
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    while (s.body.length > 0 && isBlank(lines[s.body[s.body.length - 1]!]!)) s.body.pop();
    const head = lines[s.head]!;
    if (head.startsWith(ADD)) {
      const path = head.slice(ADD.length).trim();
      const content: string[] = [];
      for (const k of s.body) {
        const l = lines[k]!;
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (l === '') content.push('');
        else throw new ParseError(k + 1);
      }
      edits.push((stage) => {
        requireSafe(path);
        if (stage.get(path) !== null) throw new EditFailure('exists', path);
        stage.set(path, newFileText(content, true));
      });
    } else if (head.startsWith(DELETE)) {
      const path = head.slice(DELETE.length).trim();
      if (s.body.length > 0) throw new ParseError(s.body[0]! + 1);
      edits.push((stage) => {
        requireSafe(path);
        if (stage.get(path) === null) throw new EditFailure('missing', path);
        stage.set(path, null);
      });
    } else {
      const path = head.slice(UPDATE.length).trim();
      let moveTo: string | null = null;
      let k = 0;
      if (s.body.length > 0 && lines[s.body[0]!]!.startsWith(MOVE)) {
        moveTo = lines[s.body[0]!]!.slice(MOVE.length).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; k < s.body.length; k += 1) {
        const idx = s.body[k]!;
        const l = lines[idx]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
        } else if (l.trim() === '*** End of File') {
          if (cur === null) throw new ParseError(idx + 1);
          cur.eof = true;
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseError(idx + 1);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0]!, text: l.slice(1) });
        } else throw new ParseError(idx + 1);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseError(s.head + 1);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function v4aUpdate(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (stage) => {
    requireSafe(path);
    if (moveTo !== null) requireSafe(moveTo);
    const text = stage.get(path);
    if (text === null) throw new EditFailure('missing', path);
    const move = moveTo !== null && moveTo !== path;
    if (moveTo !== null && stage.get(moveTo) !== null) throw new EditFailure('exists', moveTo);
    const doc = toDoc(text);
    let lines = doc.lines;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const found = findLines(lines, [c.anchor], strict, (p) => p >= cursor);
        if (found === null) throw new EditFailure('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      const old: string[] = [];
      const neu: NewLine[] = [];
      for (const b of c.body) {
        if (b.kind === ' ') {
          neu.push({ text: b.text, ctx: old.length });
          old.push(b.text);
        } else if (b.kind === '-') old.push(b.text);
        else neu.push({ text: b.text, ctx: -1 });
      }
      if (old.length === 0) {
        const at = c.eof ? lines.length : Math.min(cursor, lines.length);
        lines = [...lines.slice(0, at), ...neu.map((x) => x.text), ...lines.slice(at)];
        cursor = at + neu.length;
        continue;
      }
      const from = cursor;
      const ok = c.eof ? (p: number) => p >= from && p + old.length === lines.length : (p: number) => p >= from;
      const found = findLines(lines, old, strict, ok);
      if (found === null) throw new EditFailure('no-match', path);
      const pos = found.positions[0]!;
      lines = replaceLines(lines, pos, old.length, old, neu, found.tier);
      cursor = pos + neu.length;
    }
    const out = fromDoc({ ...doc, lines });
    if (move) {
      stage.set(path, null);
      stage.set(moveTo, out);
      return [path, moveTo];
    }
    stage.set(path, out);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;
  const existing = (stage: Stage): string => {
    requireSafe(path);
    const t = stage.get(path);
    if (t === null) throw new EditFailure('missing', path);
    return t;
  };

  if (o.command === 'create') {
    const fileText = o.file_text;
    if (typeof fileText !== 'string') return null;
    return (stage) => {
      requireSafe(path);
      if (stage.get(path) !== null) throw new EditFailure('exists', path);
      stage.set(path, fileText);
    };
  }

  if (o.command === 'str_replace') {
    const oldStr = o.old_str;
    const newStr = o.new_str === undefined ? '' : o.new_str;
    if (typeof oldStr !== 'string' || oldStr === '' || typeof newStr !== 'string') return null;
    return (stage) => {
      const before = existing(stage);
      const crlf = toDoc(before).br === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = lf(before);
      const needle = lf(oldStr);
      let count = 0;
      for (let at = text.indexOf(needle); at >= 0 && count < 2; at = text.indexOf(needle, at + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', path);
      if (count > 1) throw new EditFailure('ambiguous', path);
      const at = text.indexOf(needle);
      const out = text.slice(0, at) + lf(newStr) + text.slice(at + needle.length);
      stage.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    const line = o.insert_line;
    const newStr = o.new_str;
    if (typeof line !== 'number' || !Number.isInteger(line) || typeof newStr !== 'string') return null;
    const added = splitPatch(newStr);
    return (stage) => {
      const doc = toDoc(existing(stage));
      if (line < 0 || line > doc.lines.length) throw new EditFailure('no-match', path);
      const lines = [...doc.lines.slice(0, line), ...added, ...doc.lines.slice(line)];
      stage.set(path, fromDoc({ ...doc, lines }));
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(value)) throw new ParseError(first + 1);
    for (const item of value) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseError(first + 1);
      edits.push(e);
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (isBlank(l)) continue;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  }
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// The command line, the run and its output (SPEC.md sections 1, 2 and 10)

interface Outcome {
  code: number;
  out: string[];
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function mend(args: string[]): Outcome {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let optionsEnded = false;
  const positional: string[] = [];
  for (const a of args) {
    if (!optionsEnded && a === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchFile = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }

  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : (format as Format);
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4A(lines, strict);
    else edits = parseJson(text, lines);
    if (edits.length === 0) throw new ParseError(1);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = new Tree();
  const failures: EditFailure[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const stage = new Stage(tree);
    try {
      const moved = edit(stage);
      for (const [p, t] of stage.staged) tree.current.set(p, t);
      if (moved) moves.push(moved);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  // What changed, path by path.
  const status = new Map<string, string>();
  for (const [p, now] of tree.current) {
    const was = tree.before(p);
    if (was === now) continue;
    status.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const [from, to] of moves) {
    if (used.has(from) || used.has(to)) continue;
    if (status.get(from) === 'D' && status.get(to) === 'A') {
      used.add(from);
      used.add(to);
      rows.push({ key: to, line: `R ${from} -> ${to}` });
    }
  }
  for (const [p, s] of status) if (!used.has(p)) rows.push({ key: p, line: `${s} ${p}` });
  rows.sort((a, b) => byteOrder(a.key, b.key));

  if (!check) {
    for (const p of [...status.keys()].sort(byteOrder)) {
      const now = tree.current.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = mend(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
