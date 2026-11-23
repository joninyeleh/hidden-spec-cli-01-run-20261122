// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It implements all of SPEC.md: the command line (section 1), the output and exit codes (section 2), safe paths and
// the file model (section 3), format detection (section 4), line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set:
// keep them, and runner.ts as it is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  eol: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const eol = text.endsWith(br);
  if (eol) lines.pop();
  return { lines, br, eol };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** What a format parser needs: strict matching, and the moves its edits make (for `R` lines). */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const ch = lines[first]!.trimStart()[0] ?? '';
  if (ch === '[' || ch === '{') return 'json';
  for (const line of lines) if (line.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// --- section 5: matching at three tiers ---

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** A non-context line of N at tier 2, re-indented from O's indent to the file's (SPEC.md section 5). */
function reindentLine(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}
/** The replacement lines for a match at `pos`: context lines from the file, the rest re-indented at tier 2. */
function replacementLines(
  fileLines: string[],
  n: { text: string; ctx: boolean; oIdx: number }[],
  tier: number,
  pos: number,
  p: string,
): string[] {
  const f = leadingWs(fileLines[pos] ?? '');
  return n.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    if (tier === 2) return reindentLine(e.text, p, f);
    return e.text;
  });
}

// --- section 9: JSON edits ---
//
// The patch is one JSON array of edit objects, or JSON Lines: one edit object a line, blank lines ignored.
// In array form any fault is `error: parse <the line where the array starts>`; in JSON Lines form a line
// that does not hold one valid edit object is `error: parse <that line>`. An edit object has a string
// `path` and a `command`; keys other than those below are ignored. A wrong command or a missing or mistyped
// key is a parse fault.

function countOccurrences(hay: string, needle: string): number {
  let count = 0;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = hay.indexOf(needle, idx + 1);
  }
  return count;
}

/** One JSON edit object, or null when it does not hold a valid edit. */
function jsonEdit(v: unknown): Edit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['path'] !== 'string' || typeof o['command'] !== 'string') return null;
  const path = o['path'] as string;
  const cmd = o['command'] as string;
  if (cmd === 'create') {
    if (typeof o['file_text'] !== 'string') return null;
    const text = o['file_text'] as string;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, text);
    };
  }
  if (cmd === 'str_replace') {
    if (typeof o['old_str'] !== 'string' || o['old_str'] === '') return null;
    if (o['new_str'] !== undefined && typeof o['new_str'] !== 'string') return null;
    const oldStr = o['old_str'] as string;
    const newStr = (o['new_str'] ?? '') as string;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const crlf = parseFile(before).br === '\r\n';
      const hay = crlf ? before.replace(/\r\n/g, '\n') : before;
      const oldS = crlf ? oldStr.replace(/\r\n/g, '\n') : oldStr;
      const newS = crlf ? newStr.replace(/\r\n/g, '\n') : newStr;
      const count = countOccurrences(hay, oldS);
      if (count === 0) throw new Fail('no-match', path);
      if (count > 1) throw new Fail('ambiguous', path);
      const idx = hay.indexOf(oldS);
      let result = hay.slice(0, idx) + newS + hay.slice(idx + oldS.length);
      if (crlf) result = result.replace(/\n/g, '\r\n');
      tree.now.set(path, result);
    };
  }
  if (cmd === 'insert') {
    if (typeof o['insert_line'] !== 'number' || !Number.isInteger(o['insert_line'])) return null;
    if (typeof o['new_str'] !== 'string') return null;
    const line = o['insert_line'] as number;
    const newStr = o['new_str'] as string;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', path);
      const ins = newStrLines(newStr);
      tree.now.set(path, renderFile({ lines: [...f.lines.slice(0, line), ...ins, ...f.lines.slice(line)], br: f.br, eol: f.eol }));
    };
  }
  return null;
}

/** new_str's lines: split at \n, each with one trailing \r removed, no empty piece after a final \n. */
function newStrLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  if (text.trim() === '') return [];
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return [];
  if (lines[first]!.trimStart().startsWith('[')) {
    const startLine = first + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${startLine}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2(`error: parse ${startLine}`);
    const edits: Edit[] = [];
    for (const v of parsed) {
      const e = jsonEdit(v);
      if (e === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i]!)) continue;
    let v: unknown;
    try {
      v = JSON.parse(lines[i]!);
    } catch {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const e = jsonEdit(v);
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  }
  return edits;
}

// --- section 6: unified diffs ---

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  oLen: number;
  nLen: number;
}

function hunkEntries(h: Hunk): { o: { text: string; ctx: boolean }[]; n: { text: string; ctx: boolean; oIdx: number }[] } {
  const o: { text: string; ctx: boolean }[] = [];
  const n: { text: string; ctx: boolean; oIdx: number }[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      const oIdx = o.length;
      o.push({ text: b.text, ctx: true });
      n.push({ text: b.text, ctx: true, oIdx });
    } else if (b.kind === 'old') {
      o.push({ text: b.text, ctx: false });
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line (SPEC.md section 6). */
function hunkNoBreak(h: Hunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j++) {
    if (h.body[j]!.kind === 'ctx' || h.body[j]!.kind === 'new') last = j;
  }
  return last >= 0 && h.body[last + 1]?.kind === 'bs';
}

function applyHunk(f: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const { o, n } = hunkEntries(h);
  const oLines = o.map((e) => e.text);
  if (oLines.length === 0) {
    const ins = Math.max(0, Math.min(h.a + d, f.lines.length));
    const rep = n.map((e) => e.text);
    const eol = ins === f.lines.length ? !hunkNoBreak(h) : f.eol;
    return { lines: [...f.lines.slice(0, ins), ...rep, ...f.lines.slice(ins)], br: f.br, eol };
  }
  const found = findTier(f.lines, oLines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const rep = replacementLines(f.lines, n, found.tier, best, leadingWs(oLines[0]!));
  const eol = best + oLines.length === f.lines.length ? !hunkNoBreak(h) : f.eol;
  return { lines: [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + oLines.length)], br: f.br, eol };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    f = applyHunk(f, h, d, strict, path);
    d += h.nLen - h.oLen;
  }
  return renderFile(f);
}

interface Section {
  oldP: string | null;
  newP: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function toPath(p: string): string | null {
  return p === '/dev/null' ? null : p;
}
/** The path of a `--- ` or `+++ ` line: text after the four characters, up to the first tab, spaces removed. */
function dashPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return stripAB((tab < 0 ? t : t.slice(0, tab)).trim());
}

function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  const k = rest.indexOf(' b/');
  if (k < 0) return null;
  const x = rest.slice(0, k);
  const y = rest.slice(k + 1);
  if (!x.startsWith('a/') || !y.startsWith('b/')) return null;
  const xp = x.slice(2);
  const yp = y.slice(2);
  if (xp === '' || yp === '') return null;
  return [xp, yp];
}

function parseHunkHeader(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return parseInt(m[1]!, 10);
}

function parseBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      body.push({ kind: 'ctx', text: '', raw: line });
      i++;
      continue;
    }
    const c = line[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: line.slice(1), raw: line });
      i++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: line.slice(1), raw: line });
      i++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: line.slice(1), raw: line });
      i++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: line, raw: line });
      i++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it: a context line whose text is empty.
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  return { body, next: i };
}

/**
 * The rest of a unified section starting at `start`: header lines and hunks, up to the next section's start or
 * the end of the patch. Returns the index where the section ended. `pair` says a `--- `+`+++ ` pair was
 * already read for this section.
 */
function parseSectionRest(lines: string[], start: number, sec: Section, pair: boolean): number {
  let i = start;
  const n = lines.length;
  let inHeader = true;
  let hasPair = pair;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i);
      i++;
      const { body, next } = parseBody(lines, i);
      i = next;
      const hunk: Hunk = { a, body, oLen: 0, nLen: 0 };
      const e = hunkEntries(hunk);
      hunk.oLen = e.o.length;
      hunk.nLen = e.n.length;
      sec.hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (inHeader && !hasPair) {
          sec.oldP = toPath(dashPath(line));
          sec.newP = toPath(dashPath(lines[i + 1]!));
          hasPair = true;
          i += 2;
          continue;
        }
        break;
      }
      if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('rename from ')) {
        renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (!hasPair && renameOld !== null) sec.oldP = toPath(renameOld);
  if (!hasPair && renameNew !== null) sec.newP = toPath(renameNew);
  return i;
}

function creationEdit(np: string, hunks: Hunk[]): Edit {
  return (tree) => {
    if (!safe(np)) throw new Fail('unsafe', np);
    if (tree.get(np) !== null) throw new Fail('exists', np);
    const plus: { hunk: Hunk; idx: number }[] = [];
    const lines: string[] = [];
    for (const h of hunks) {
      h.body.forEach((b, j) => {
        if (b.kind === 'new') {
          plus.push({ hunk: h, idx: j });
          lines.push(b.text);
        }
      });
    }
    let noBreak = false;
    if (plus.length > 0) {
      const lastPlus = plus[plus.length - 1]!;
      noBreak = lastPlus.hunk.body[lastPlus.idx + 1]?.kind === 'bs';
    }
    tree.now.set(np, lines.length === 0 ? '' : lines.join('\n') + (noBreak ? '' : '\n'));
  };
}

function deletionEdit(op: string): Edit {
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.now.set(op, null);
  };
}

function sectionEdit(sec: Section, ctx: Ctx): Edit {
  const oldP = sec.oldP;
  const newP = sec.newP;
  if (oldP === null && newP === null) return () => {};
  if (oldP === null) return creationEdit(newP!, sec.hunks);
  if (newP === null) return deletionEdit(oldP!);
  if (sec.create) return creationEdit(newP!, sec.hunks);
  if (sec.del) return deletionEdit(oldP!);
  if (oldP !== newP) {
    const op = oldP!;
    const np = newP!;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const result = applyHunks(before, sec.hunks, ctx.strict, op);
      tree.now.set(np, result);
      tree.now.set(op, null);
      ctx.moves.push([op, np]);
    };
  }
  const p = oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const result = applyHunks(before, sec.hunks, ctx.strict, p);
    tree.now.set(p, result);
  };
}

function parseUnified(lines: string[], ctx: Ctx): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = parseDiffGit(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldP: g[0], newP: g[1], create: false, del: false, hunks: [] };
      sections.push(sec);
      i = parseSectionRest(lines, i + 1, sec, false);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldP: null, newP: null, create: false, del: false, hunks: [] };
      sec.oldP = toPath(dashPath(line));
      sec.newP = toPath(dashPath(lines[i + 1]!));
      sections.push(sec);
      i = parseSectionRest(lines, i + 2, sec, true);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return sections.map((s) => sectionEdit(s, ctx));
}

// --- section 7: SEARCH/REPLACE blocks ---

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const n = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rep = replacementLines(f.lines, n, found.tier, pos, leadingWs(oldLines[0]!));
    tree.now.set(path, renderFile({ lines: [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oldLines.length)], br: f.br, eol: f.eol }));
  };
}

function parseSearchReplace(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '=======') {
        eq = j;
        break;
      }
      if (l === '>>>>>>> REPLACE' || l === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (l === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, ctx.strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// --- section 8: V4A patches ---

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function bodyFromRaw(raw: string[]): BodyLine[] {
  return raw.map((l) => {
    if (l === '') return { kind: 'ctx' as const, text: '', raw: l };
    const c = l[0]!;
    if (c === ' ') return { kind: 'ctx' as const, text: l.slice(1), raw: l };
    if (c === '-') return { kind: 'old' as const, text: l.slice(1), raw: l };
    return { kind: 'new' as const, text: l.slice(1), raw: l };
  });
}

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(anchor, lines[i]!, t)) return i;
    }
  }
  return null;
}

function updateEdit(path: string, moveTo: string | null, chunks: VChunk[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findAnchor(f.lines, ch.anchor, cursor, ctx.strict);
        if (a === null) throw new Fail('no-match', path);
        cursor = a + 1;
      }
      const o: { text: string; ctx: boolean }[] = [];
      const n: { text: string; ctx: boolean; oIdx: number }[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          const oIdx = o.length;
          o.push({ text: b.text, ctx: true });
          n.push({ text: b.text, ctx: true, oIdx });
        } else if (b.kind === 'old') {
          o.push({ text: b.text, ctx: false });
        } else if (b.kind === 'new') {
          n.push({ text: b.text, ctx: false, oIdx: -1 });
        }
      }
      const oLines = o.map((e) => e.text);
      if (oLines.length === 0) {
        const ins = ch.eof ? f.lines.length : cursor;
        const rep = n.map((e) => e.text);
        f = { lines: [...f.lines.slice(0, ins), ...rep, ...f.lines.slice(ins)], br: f.br, eol: f.eol };
        cursor = ins + rep.length;
      } else {
        const found = findTierFrom(f.lines, oLines, cursor, ctx.strict);
        if (found === null) throw new Fail('no-match', path);
        let pos: number;
        if (ch.eof) {
          const enders = found.pos.filter((p) => p + oLines.length === f.lines.length);
          if (enders.length === 0) throw new Fail('no-match', path);
          pos = enders[0]!;
        } else {
          pos = found.pos[0]!;
        }
        const rep = replacementLines(f.lines, n, found.tier, pos, leadingWs(oLines[0]!));
        f = { lines: [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oLines.length)], br: f.br, eol: f.eol };
        cursor = pos + rep.length;
      }
    }
    const result = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      ctx.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

/** True when every line from `i` to the next section start or `last` is blank: the blanks end the section. */
function onlyBlanksUntilSectionEnd(lines: string[], i: number, last: number, isSectionStart: (l: string) => boolean): boolean {
  let j = i;
  while (j < last) {
    const l = lines[j]!;
    if (isSectionStart(l)) return true;
    if (!blank(l)) return false;
    j++;
  }
  return true;
}

function parseV4a(lines: string[], ctx: Ctx): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          raw.push(l);
          i++;
          continue;
        }
        if (l === '') {
          raw.push(l);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const content = raw.map((r) => (r.startsWith('+') ? r.slice(1) : r));
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(deletionEdit(p));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; raw: string[] } | null = null;
      let started = false;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push({ anchor: cur.anchor, eof: cur.eof, body: bodyFromRaw(cur.raw) });
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, raw: [] };
          started = true;
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push({ anchor: cur.anchor, eof: cur.eof, body: bodyFromRaw(cur.raw) });
          cur = null;
          i++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (started) {
              // A blank line after a chunk ended: at the end of the section it is ignored, else a fault.
              if (blank(l) && onlyBlanksUntilSectionEnd(lines, i, last, isSectionStart)) {
                i++;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, eof: false, raw: [] };
            started = true;
          }
          cur.raw.push(l);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        // Blank lines at the end of a section are not part of it.
        while (cur.raw.length > 0 && blank(cur.raw[cur.raw.length - 1]!)) cur.raw.pop();
        chunks.push({ anchor: cur.anchor, eof: cur.eof, body: bodyFromRaw(cur.raw) });
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(updateEdit(p, moveTo, chunks, ctx));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// --- section 1: command line, section 2: output and exit codes, section 10: the write ---

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, ctx);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, ctx);
    else edits = parseV4a(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const byteOrd = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const consumed = new Set<string>();
  const rowList: { key: string; line: string }[] = [];
  for (const [oldP, newP] of ctx.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rowList.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrd)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!consumed.has(p)) rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rowList.sort((a, b) => byteOrd(a.key, b.key));
  const rows = rowList.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

if (process.env['MAKEFUN_ENV_URL']) {
  const { runTrial } = await import('./runner.ts');
  process.exitCode = await runTrial(run);
} else {
  const r = run(process.argv.slice(2));
  for (const line of r.out) writeSync(1, line + '\n');
  process.exitCode = r.code;
}
