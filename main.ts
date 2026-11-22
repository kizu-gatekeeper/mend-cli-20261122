// mend — one patch tool for every AI edit format.
//
// Reads a patch in unified-diff, SEARCH/REPLACE, V4A or JSON form, locates the
// lines each edit names (tolerating drifted whitespace and indentation), and
// rewrites the tree atomically: every change lands, or none does. The full
// contract lives in SPEC.md; this file implements it using nothing beyond the
// Node standard library.
//
// When MAKEFUN_ENV_URL is set the process is running inside a make.fun trial,
// so control passes to the kit runner sitting beside this file.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Error carriers. A ParseProblem aborts the whole run before any file is
// examined (exit 2). An EditProblem fails exactly one edit (exit 1 overall)
// while the remaining edits still get their chance.
// ---------------------------------------------------------------------------

class ParseProblem extends Error {
  atLine: number;
  constructor(atLine: number) {
    super(`parse problem at patch line ${atLine}`);
    this.atLine = atLine;
  }
}

class EditProblem extends Error {
  kind: string;
  target: string;
  constructor(kind: string, target: string) {
    super(`${kind} ${target}`);
    this.kind = kind;
    this.target = target;
  }
}

function fail(kind: string, target: string): never {
  throw new EditProblem(kind, target);
}

// ---------------------------------------------------------------------------
// Small text helpers shared by every format reader.
// ---------------------------------------------------------------------------

const FORMAT_NAMES: readonly string[] = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function isBlankText(s: string): boolean {
  return s.trim() === '';
}

// A patch is read as lines split on \n; each line loses at most one trailing
// \r, and the empty fragment after a final \n is not a line of its own.
function splitPatchText(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, p.length - 1) : p));
}

// The same splitting rule, reused for strings that arrive inside JSON edits.
function splitStringLines(text: string): string[] {
  return splitPatchText(text);
}

function pathIsSafe(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function requireSafe(p: string): void {
  if (!pathIsSafe(p)) fail('unsafe', p);
}

function dropTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function dropBothWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWsOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// ---------------------------------------------------------------------------
// The virtual tree. Edits never touch the disk directly; they read through
// this overlay and record their outcome in it. Only when every edit has
// succeeded does the caller flush the overlay, which is what makes a patch
// atomic. Rolling one edit back is just restoring a snapshot of the overlay.
// ---------------------------------------------------------------------------

class VirtualTree {
  private diskCache = new Map<string, string | null>();
  overlay = new Map<string, string | null>();

  readOriginal(p: string): string | null {
    if (!this.diskCache.has(p)) {
      let found: string | null = null;
      try {
        if (statSync(p).isFile()) found = readFileSync(p, 'utf8');
      } catch {
        found = null;
      }
      this.diskCache.set(p, found);
    }
    return this.diskCache.get(p) as string | null;
  }

  read(p: string): string | null {
    if (this.overlay.has(p)) return this.overlay.get(p) as string | null;
    return this.readOriginal(p);
  }

  put(p: string, text: string | null): void {
    this.overlay.set(p, text);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.overlay);
  }

  restore(snap: Map<string, string | null>): void {
    this.overlay = new Map(snap);
  }
}

// ---------------------------------------------------------------------------
// File anatomy: a file has one kind of line break, a list of lines, and a
// flag saying whether the text ends with that break.
// ---------------------------------------------------------------------------

interface FileShape {
  br: string;
  lines: string[];
  endsWithBreak: boolean;
}

function dissectFile(text: string): FileShape {
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text.charAt(firstNl - 1) === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], endsWithBreak: false };
  const pieces = text.split(br);
  const endsWithBreak = text.endsWith(br);
  if (endsWithBreak) pieces.pop();
  return { br, lines: pieces, endsWithBreak };
}

function assembleFile(shape: FileShape): string {
  if (shape.lines.length === 0) return '';
  return shape.lines.join(shape.br) + (shape.endsWithBreak ? shape.br : '');
}

// A brand-new file is written with LF breaks; callers pass the final-break
// choice their format demands.
function assembleCreated(lines: string[], endsWithBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (endsWithBreak ? '\n' : '');
}

// ---------------------------------------------------------------------------
// Tiered line matching. An old block O is searched for at tier 0 (exact),
// then tier 1 (trailing blanks ignored), then tier 2 (both edges ignored).
// The first tier that yields at least one occurrence wins; --strict stops
// after tier 0.
// ---------------------------------------------------------------------------

function linesMatchAtTier(have: string, want: string, tier: number): boolean {
  if (tier === 0) return have === want;
  if (tier === 1) return dropTrailingWs(have) === dropTrailingWs(want);
  return dropBothWs(have) === dropBothWs(want);
}

interface TierHit {
  tier: number;
  spots: number[];
}

// Every start index >= fromIndex where the block `oldLines` occurs, at the
// winning tier. When endLocked is set, only occurrences whose end coincides
// with the file's last line count (V4A end-of-file chunks).
function locateBlock(
  fileLines: string[],
  oldLines: string[],
  fromIndex: number,
  strict: boolean,
  endLocked: boolean,
): TierHit | null {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier += 1) {
    const spots: number[] = [];
    for (let i = Math.max(0, fromIndex); i + oldLines.length <= fileLines.length; i += 1) {
      if (endLocked && i + oldLines.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (!linesMatchAtTier(fileLines[i + j] as string, oldLines[j] as string, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) spots.push(i);
    }
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

// Find a single anchor line at or after fromIndex, tier by tier.
function locateAnchor(fileLines: string[], anchor: string, fromIndex: number, strict: boolean): number {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier += 1) {
    for (let i = Math.max(0, fromIndex); i < fileLines.length; i += 1) {
      if (linesMatchAtTier(fileLines[i] as string, anchor, tier)) return i;
    }
  }
  return -1;
}

// One line of a replacement block. Context lines are shared with the old
// block: they are re-emitted as the file's own matched line, and oldIndex
// says which matched line that is. Fresh lines carry their patch text.
interface NewLine {
  isContext: boolean;
  text: string;
  oldIndex: number;
}

// Build the lines that replace fileLines[at .. at+oldCount). At tier 2 the
// fresh lines are re-indented: the first old line's indent P is swapped for
// the first matched file line's indent F on any non-blank fresh line that
// begins with P.
function buildReplacement(
  fileLines: string[],
  at: number,
  fresh: NewLine[],
  tier: number,
  firstOldLine: string,
): string[] {
  const out: string[] = [];
  let fileLead = '';
  let patchLead = '';
  if (tier === 2) {
    fileLead = leadingWsOf(fileLines[at] as string);
    patchLead = leadingWsOf(firstOldLine);
  }
  for (const nl of fresh) {
    if (nl.isContext) {
      out.push(fileLines[at + nl.oldIndex] as string);
    } else if (tier === 2 && nl.text.trim() !== '' && nl.text.startsWith(patchLead)) {
      out.push(fileLead + nl.text.slice(patchLead.length));
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// Splice a built replacement into a line list, returning the new list.
function spliceLines(lines: string[], at: number, oldCount: number, inserted: string[]): string[] {
  return [...lines.slice(0, at), ...inserted, ...lines.slice(at + oldCount)];
}

// ---------------------------------------------------------------------------
// An edit is a closure over its parsed patch data. Applying it either mutates
// the virtual tree or throws EditProblem. Moves are reported back through
// `moves` so the final summary can print an R line for them.
// ---------------------------------------------------------------------------

interface RunOptions {
  strict: boolean;
}

type EditFn = (tree: VirtualTree, opts: RunOptions, moves: Array<[string, string]>) => void;

// Shared "file must be there" read for change-style edits.
function mustExist(tree: VirtualTree, p: string): string {
  const text = tree.read(p);
  if (text === null) fail('missing', p);
  return text as string;
}

// ---------------------------------------------------------------------------
// Unified diffs. A section opens with a diff --git line or with a ---/+++
// header pair that does not belong to an earlier section. Header lines name
// the paths; hunks then carry the changes. A section is a single edit.
// ---------------------------------------------------------------------------

interface HunkBodyLine {
  kind: 'ctx' | 'del' | 'add' | 'marker';
  text: string;
  rawEmpty: boolean; // true when the patch line itself was empty
}

interface Hunk {
  startA: number;
  body: HunkBodyLine[];
}

interface DiffSection {
  pairOld: string | null | undefined; // undefined: no --- line seen
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  flagCreate: boolean;
  flagDelete: boolean;
  hunks: Hunk[];
}

// The path written after --- or +++: up to the first tab, edges trimmed of
// spaces, /dev/null kept as the null sentinel, one a/ or b/ prefix stripped.
function headerPath(raw: string): string | null {
  let p = (raw.split('\t')[0] as string).replace(/^ +/, '').replace(/ +$/, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): EditFn[] {
  const sections: DiffSection[] = [];
  let sec: DiffSection | null = null;
  let inHeader = false;

  const openSection = (): DiffSection => {
    const s: DiffSection = {
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      flagCreate: false,
      flagDelete: false,
      hunks: [],
    };
    sections.push(s);
    sec = s;
    inHeader = true;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const lineNo = i + 1;

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m === null || (m[1] as string) === '' || (m[2] as string) === '') {
        throw new ParseProblem(lineNo);
      }
      const s = openSection();
      s.diffOld = m[1] as string;
      s.diffNew = m[2] as string;
      i += 1;
      continue;
    }

    if (line.startsWith('--- ')) {
      const next = i + 1 < lines.length ? (lines[i + 1] as string) : null;
      const followed = next !== null && next.startsWith('+++ ');
      if (sec !== null && inHeader && sec.pairOld === undefined) {
        // This pair belongs to the open section's header; a --- without its
        // +++ inside a header faults, naming the line after the --- line.
        if (!followed) throw new ParseProblem(lineNo + 1);
        sec.pairOld = headerPath(line.slice(4));
        sec.pairNew = headerPath((next as string).slice(4));
        i += 2;
        continue;
      }
      if (followed) {
        const s = openSection();
        s.pairOld = headerPath(line.slice(4));
        s.pairNew = headerPath((next as string).slice(4));
        i += 2;
        continue;
      }
      i += 1; // a stray --- outside any header is prose
      continue;
    }

    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseProblem(lineNo);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new ParseProblem(lineNo);
      const hunk: Hunk = { startA: Number(m[1]), body: [] };
      i += 1;
      // Consume the body: lines opening with space, -, + or \, plus empty
      // lines (context lines with empty text). The body stops at the next
      // section's start or at any foreign line.
      while (i < lines.length) {
        const b = lines[i] as string;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < lines.length && (lines[i + 1] as string).startsWith('+++ ')) break;
        if (b === '') hunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
        else if (b.startsWith(' ')) hunk.body.push({ kind: 'ctx', text: b.slice(1), rawEmpty: false });
        else if (b.startsWith('-')) hunk.body.push({ kind: 'del', text: b.slice(1), rawEmpty: false });
        else if (b.startsWith('+')) hunk.body.push({ kind: 'add', text: b.slice(1), rawEmpty: false });
        else if (b.startsWith('\\')) hunk.body.push({ kind: 'marker', text: b, rawEmpty: false });
        else break;
        i += 1;
      }
      // Empty patch lines trailing a body were never part of it.
      while (hunk.body.length > 0 && (hunk.body[hunk.body.length - 1] as HunkBodyLine).rawEmpty) {
        hunk.body.pop();
      }
      sec.hunks.push(hunk);
      inHeader = false;
      continue;
    }

    // Header bookkeeping for the open section; all else is ignored prose.
    if (sec !== null && inHeader) {
      if (line.startsWith('+++ ')) {
        sec.pairNew = headerPath(line.slice(4));
        if (sec.pairOld === undefined) sec.pairOld = null;
      } else if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        sec.flagCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        sec.flagDelete = true;
      }
    }
    i += 1;
  }

  return sections.map((s) => makeUnifiedEdit(s));
}

// Does a \ marker directly follow the hunk's last context or + line?
function markerAfterLastWrite(body: HunkBodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const e = body[k] as HunkBodyLine;
    if (e.kind === 'ctx' || e.kind === 'add') {
      const nxt = body[k + 1] as HunkBodyLine | undefined;
      return nxt !== undefined && nxt.kind === 'marker';
    }
  }
  return false;
}

function makeUnifiedEdit(sec: DiffSection): EditFn {
  // Effective paths: the ---/+++ pair wins, then renames, then diff --git.
  const oldPath: string | null =
    sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== null ? sec.renameFrom : sec.diffOld;
  const newPath: string | null =
    sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== null ? sec.renameTo : sec.diffNew;
  const isCreate = sec.flagCreate || (sec.pairOld !== undefined && sec.pairOld === null);
  const isDelete = sec.flagDelete || (sec.pairNew !== undefined && sec.pairNew === null);

  return (tree, opts, moves) => {
    if (isCreate) {
      const target = newPath as string;
      requireSafe(target);
      if (tree.read(target) !== null) fail('exists', target);
      const content: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        h.body.forEach((e, ei) => {
          if (e.kind === 'add') {
            content.push(e.text);
            const nxt = h.body[ei + 1] as HunkBodyLine | undefined;
            noBreak = nxt !== undefined && nxt.kind === 'marker';
          }
        });
      }
      tree.put(target, assembleCreated(content, !noBreak));
      return;
    }

    if (isDelete) {
      const target = oldPath as string;
      requireSafe(target);
      mustExist(tree, target);
      tree.put(target, null);
      return;
    }

    const from = oldPath as string;
    const to = newPath as string;
    requireSafe(from);
    if (to !== from) requireSafe(to);
    const before = mustExist(tree, from);
    if (to !== from && tree.read(to) !== null) fail('exists', to);

    const shape = dissectFile(before);
    let work = shape.lines;
    let endsWithBreak = shape.endsWithBreak;
    let drift = 0; // sum of (new-old) lengths over hunks already applied

    for (const h of sec.hunks) {
      const oldBlock: string[] = [];
      const fresh: NewLine[] = [];
      for (const e of h.body) {
        if (e.kind === 'ctx') {
          fresh.push({ isContext: true, text: e.text, oldIndex: oldBlock.length });
          oldBlock.push(e.text);
        } else if (e.kind === 'del') {
          oldBlock.push(e.text);
        } else if (e.kind === 'add') {
          fresh.push({ isContext: false, text: e.text, oldIndex: -1 });
        }
      }
      const noBreak = markerAfterLastWrite(h.body);
      if (oldBlock.length === 0) {
        // Pure insertion: after the first startA+drift lines, or at the end
        // when the file is shorter than that.
        const at = Math.min(h.startA + drift, work.length);
        const built = fresh.map((f) => f.text);
        const insertedAtEnd = at === work.length;
        work = spliceLines(work, at, 0, built);
        if (insertedAtEnd) endsWithBreak = !noBreak;
      } else {
        const hit = locateBlock(work, oldBlock, 0, opts.strict, false);
        if (hit === null) fail('no-match', from);
        // The occurrence nearest the hunk's stated position wins; ties go
        // to the earlier one.
        const wanted = h.startA - 1 + drift;
        let chosen = hit.spots[0] as number;
        for (const s of hit.spots) {
          if (Math.abs(s - wanted) < Math.abs(chosen - wanted)) chosen = s;
        }
        const runsToEnd = chosen + oldBlock.length === work.length;
        const built = buildReplacement(work, chosen, fresh, hit.tier, oldBlock[0] as string);
        work = spliceLines(work, chosen, oldBlock.length, built);
        if (runsToEnd) endsWithBreak = !noBreak;
      }
      drift += fresh.length - oldBlock.length;
    }

    const result = assembleFile({ br: shape.br, lines: work, endsWithBreak });
    if (to !== from) {
      tree.put(from, null);
      tree.put(to, result);
      moves.push([from, to]);
    } else {
      tree.put(from, result);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks. Each block names its file on a nearby line above
// the SEARCH marker, or inherits the previous block's path. A block whose
// old lines are empty creates the file; otherwise the old lines must occur
// exactly once at their tier.
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): EditFn[] {
  const blocks: SrBlock[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0; // first patch index not yet consumed by a block
  let i = 0;
  while (i < lines.length) {
    if (dropTrailingWs(lines[i] as string) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLineNo = i + 1;
    // Path: nearest earlier line that is neither blank nor a code fence,
    // searching back no further than the previous block's end.
    let foundPath: string | null = null;
    for (let k = i - 1; k >= scanFrom; k -= 1) {
      const cand = lines[k] as string;
      if (isBlankText(cand)) continue;
      const trimmed = cand.trim();
      if (trimmed.startsWith('```')) continue;
      foundPath = trimmed;
      break;
    }
    let usePath: string;
    if (foundPath !== null) usePath = foundPath;
    else if (prevPath !== null) usePath = prevPath;
    else throw new ParseProblem(searchLineNo);

    // The ======= divider, then the >>>>>>> REPLACE closer.
    let divider = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (dropTrailingWs(lines[k] as string) === '=======') {
        divider = k;
        break;
      }
    }
    let closer = -1;
    if (divider >= 0) {
      for (let k = divider + 1; k < lines.length; k += 1) {
        if (dropTrailingWs(lines[k] as string) === '>>>>>>> REPLACE') {
          closer = k;
          break;
        }
      }
    }
    if (divider < 0 || closer < 0) throw new ParseProblem(searchLineNo);

    blocks.push({
      path: usePath,
      oldLines: lines.slice(i + 1, divider),
      newLines: lines.slice(divider + 1, closer),
    });
    prevPath = usePath;
    scanFrom = closer + 1;
    i = closer + 1;
  }

  return blocks.map((b) => makeSearchReplaceEdit(b));
}

function makeSearchReplaceEdit(block: SrBlock): EditFn {
  return (tree, opts) => {
    requireSafe(block.path);
    if (block.oldLines.length === 0) {
      if (tree.read(block.path) !== null) fail('exists', block.path);
      tree.put(block.path, assembleCreated(block.newLines, true));
      return;
    }
    const before = mustExist(tree, block.path);
    const shape = dissectFile(before);
    const hit = locateBlock(shape.lines, block.oldLines, 0, opts.strict, false);
    if (hit === null) fail('no-match', block.path);
    if (hit.spots.length > 1) fail('ambiguous', block.path);
    const at = hit.spots[0] as number;
    const fresh: NewLine[] = block.newLines.map((t) => ({ isContext: false, text: t, oldIndex: -1 }));
    const built = buildReplacement(shape.lines, at, fresh, hit.tier, block.oldLines[0] as string);
    const work = spliceLines(shape.lines, at, block.oldLines.length, built);
    tree.put(block.path, assembleFile({ br: shape.br, lines: work, endsWithBreak: shape.endsWithBreak }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches. Framed by Begin/End Patch markers, the body is a run of Add,
// Delete and Update sections. Update sections hold chunks that apply in
// order behind a cursor; a chunk may be anchored by a line of context or
// pinned to the end of the file.
// ---------------------------------------------------------------------------

interface V4aChunkLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

interface V4aChunk {
  anchor: string | null;
  endOfFile: boolean;
  body: V4aChunkLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function parseV4a(lines: string[]): EditFn[] {
  const firstIdx = lines.findIndex((l) => !isBlankText(l));
  if (firstIdx < 0) throw new ParseProblem(1);
  if ((lines[firstIdx] as string).trim() !== '*** Begin Patch') {
    throw new ParseProblem(firstIdx + 1);
  }
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlankText(lines[k] as string)) {
      lastIdx = k;
      break;
    }
  }
  if ((lines[lastIdx] as string).trim() !== '*** End Patch') {
    throw new ParseProblem(lines.length + 1);
  }

  const sections: V4aSection[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = lines[i] as string;
    if (isBlankText(line)) {
      i += 1;
      continue;
    }
    let kind: V4aSection['kind'] | null = null;
    let path = '';
    if (line.startsWith(V4A_ADD)) {
      kind = 'add';
      path = line.slice(V4A_ADD.length).trim();
    } else if (line.startsWith(V4A_DEL)) {
      kind = 'delete';
      path = line.slice(V4A_DEL.length).trim();
    } else if (line.startsWith(V4A_UPD)) {
      kind = 'update';
      path = line.slice(V4A_UPD.length).trim();
    } else {
      throw new ParseProblem(i + 1);
    }
    const headerLineNo = i + 1;
    i += 1;
    // Gather this section's raw lines (with their patch line numbers) up to
    // the next section header or the End Patch line.
    const raw: Array<{ text: string; no: number }> = [];
    while (i < lastIdx) {
      const l = lines[i] as string;
      if (l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD)) break;
      raw.push({ text: l, no: i + 1 });
      i += 1;
    }
    // Blank lines at a section's tail are not part of the section; a blank
    // line is empty or holds nothing but whitespace.
    while (raw.length > 0 && isBlankText((raw[raw.length - 1] as { text: string }).text)) raw.pop();

    const section: V4aSection = {
      kind: kind as V4aSection['kind'],
      path,
      lineNo: headerLineNo,
      addLines: [],
      moveTo: null,
      chunks: [],
    };

    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) section.addLines.push(r.text.slice(1));
        else if (r.text === '') section.addLines.push('');
        else throw new ParseProblem(r.no);
      }
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!isBlankText(r.text)) throw new ParseProblem(r.no);
      }
    } else {
      let start = 0;
      if (raw.length > 0 && (raw[0] as { text: string }).text.startsWith(V4A_MOVE)) {
        section.moveTo = (raw[0] as { text: string }).text.slice(V4A_MOVE.length).trim();
        start = 1;
      }
      let chunk: V4aChunk | null = null;
      for (let k = start; k < raw.length; k += 1) {
        const r = raw[k] as { text: string; no: number };
        if (r.text.startsWith('@@')) {
          chunk = { anchor: r.text.slice(2).trim() || null, endOfFile: false, body: [] };
          section.chunks.push(chunk);
        } else if (r.text === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, endOfFile: true, body: [] };
            section.chunks.push(chunk);
          } else {
            chunk.endOfFile = true;
          }
          chunk = null; // the next body line opens a fresh chunk
        } else if (r.text.startsWith(' ') || r.text.startsWith('-') || r.text.startsWith('+') || r.text === '') {
          if (chunk === null) {
            chunk = { anchor: null, endOfFile: false, body: [] };
            section.chunks.push(chunk);
          }
          if (r.text === '') chunk.body.push({ kind: 'ctx', text: '' });
          else if (r.text.startsWith(' ')) chunk.body.push({ kind: 'ctx', text: r.text.slice(1) });
          else if (r.text.startsWith('-')) chunk.body.push({ kind: 'del', text: r.text.slice(1) });
          else chunk.body.push({ kind: 'add', text: r.text.slice(1) });
        } else {
          throw new ParseProblem(r.no);
        }
      }
      if (section.chunks.length === 0 && section.moveTo === null) {
        throw new ParseProblem(headerLineNo);
      }
    }
    sections.push(section);
  }

  return sections.map((s) => makeV4aEdit(s));
}

function makeV4aEdit(sec: V4aSection): EditFn {
  return (tree, opts, moves) => {
    requireSafe(sec.path);
    if (sec.kind === 'add') {
      if (tree.read(sec.path) !== null) fail('exists', sec.path);
      tree.put(sec.path, assembleCreated(sec.addLines, true));
      return;
    }
    if (sec.kind === 'delete') {
      mustExist(tree, sec.path);
      tree.put(sec.path, null);
      return;
    }
    // Update, possibly with a move.
    if (sec.moveTo !== null) requireSafe(sec.moveTo);
    const before = mustExist(tree, sec.path);
    if (sec.moveTo !== null && tree.read(sec.moveTo) !== null) fail('exists', sec.moveTo);
    const shape = dissectFile(before);
    let work = shape.lines;
    let cursor = 0;

    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = locateAnchor(work, chunk.anchor, cursor, opts.strict);
        if (at < 0) fail('no-match', sec.path);
        cursor = at + 1;
      }
      const oldBlock: string[] = [];
      const fresh: NewLine[] = [];
      for (const e of chunk.body) {
        if (e.kind === 'ctx') {
          fresh.push({ isContext: true, text: e.text, oldIndex: oldBlock.length });
          oldBlock.push(e.text);
        } else if (e.kind === 'del') {
          oldBlock.push(e.text);
        } else {
          fresh.push({ isContext: false, text: e.text, oldIndex: -1 });
        }
      }
      if (oldBlock.length === 0) {
        const at = chunk.endOfFile ? work.length : Math.min(cursor, work.length);
        const built = fresh.map((f) => f.text);
        work = spliceLines(work, at, 0, built);
        cursor = at + built.length;
      } else {
        const hit = locateBlock(work, oldBlock, cursor, opts.strict, chunk.endOfFile);
        if (hit === null) fail('no-match', sec.path);
        const at = hit.spots[0] as number;
        const built = buildReplacement(work, at, fresh, hit.tier, oldBlock[0] as string);
        work = spliceLines(work, at, oldBlock.length, built);
        cursor = at + built.length;
      }
    }

    const result = assembleFile({ br: shape.br, lines: work, endsWithBreak: shape.endsWithBreak });
    if (sec.moveTo !== null) {
      tree.put(sec.path, null);
      tree.put(sec.moveTo, result);
      moves.push([sec.path, sec.moveTo]);
    } else {
      tree.put(sec.path, result);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits. The patch is one array of edit objects, or JSON Lines with one
// object per line. Matching for str_replace is exact text, never tiered.
// ---------------------------------------------------------------------------

function buildJsonEdit(value: unknown): EditFn | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const p = obj.path;
  if (typeof p !== 'string') return null;

  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    const text = obj.file_text;
    return (tree) => {
      requireSafe(p);
      if (tree.read(p) !== null) fail('exists', p);
      tree.put(p, text);
    };
  }

  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') return null;
    const oldStr = obj.old_str;
    const newStr = typeof obj.new_str === 'string' ? obj.new_str : '';
    return (tree) => {
      requireSafe(p);
      const before = mustExist(tree, p);
      const firstNl = before.indexOf('\n');
      const crlf = firstNl > 0 && before.charAt(firstNl - 1) === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const hay = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) count += 1;
      if (count === 0) fail('no-match', p);
      if (count > 1) fail('ambiguous', p);
      const at = hay.indexOf(needle);
      const merged = hay.slice(0, at) + toLf(newStr) + hay.slice(at + needle.length);
      tree.put(p, crlf ? merged.split('\n').join('\r\n') : merged);
    };
  }

  if (obj.command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    const lineNo = obj.insert_line;
    const additions = splitStringLines(obj.new_str);
    return (tree) => {
      requireSafe(p);
      const before = mustExist(tree, p);
      const shape = dissectFile(before);
      if (lineNo < 0 || lineNo > shape.lines.length) fail('no-match', p);
      const work = spliceLines(shape.lines, lineNo, 0, additions);
      tree.put(p, assembleFile({ br: shape.br, lines: work, endsWithBreak: shape.endsWithBreak }));
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const firstIdx = lines.findIndex((l) => !isBlankText(l));
  if (firstIdx < 0) throw new ParseProblem(1);
  const edits: EditFn[] = [];
  if ((lines[firstIdx] as string).trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseProblem(firstIdx + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseProblem(firstIdx + 1);
    for (const item of parsed) {
      const e = buildJsonEdit(item);
      if (e === null) throw new ParseProblem(firstIdx + 1);
      edits.push(e);
    }
    return edits;
  }
  for (let idx = 0; idx < lines.length; idx += 1) {
    const l = lines[idx] as string;
    if (isBlankText(l)) continue;
    let e: EditFn | null = null;
    try {
      e = buildJsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseProblem(idx + 1);
    edits.push(e);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Format detection for --format=auto, in the specification's order.
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const firstIdx = lines.findIndex((l) => !isBlankText(l));
  if (firstIdx < 0) return null;
  const first = lines[firstIdx] as string;
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const lead = first.trimStart().charAt(0);
  if (lead === '[' || lead === '{') return 'json';
  for (const l of lines) {
    if (dropTrailingWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let idx = 0; idx < lines.length; idx += 1) {
    const l = lines[idx] as string;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && idx + 1 < lines.length && (lines[idx + 1] as string).startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The driver: parse the command line, read the patch, parse it into edits,
// run the edits against the virtual tree, then either report the failures
// (writing nothing) or flush and summarise the changes.
// ---------------------------------------------------------------------------

interface Outcome {
  code: number;
  outLines: string[];
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function execute(argv: string[]): Outcome {
  let formatArg: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;

  for (const arg of argv) {
    if (!afterDashDash && arg === '--') {
      afterDashDash = true;
    } else if (!afterDashDash && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && formatArg === null && FORMAT_NAMES.includes(arg.slice('--format='.length))) {
        formatArg = arg.slice('--format='.length);
      } else if (arg === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, outLines: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, outLines: ['error: usage'] };

  const patchPath = positional.length === 0 || positional[0] === '-' ? null : (positional[0] as string);
  let patchText = '';
  try {
    patchText = readFileSync(patchPath === null ? 0 : patchPath, 'utf8');
  } catch {
    if (patchPath !== null) return { code: 2, outLines: ['error: no-patch'] };
  }
  const patchLineList = splitPatchText(patchText);

  const kind = formatArg === null || formatArg === 'auto' ? detectFormat(patchLineList) : formatArg;
  if (kind === null) return { code: 2, outLines: ['error: format'] };

  let edits: EditFn[];
  try {
    if (kind === 'unified') edits = parseUnified(patchLineList);
    else if (kind === 'search-replace') edits = parseSearchReplace(patchLineList);
    else if (kind === 'v4a') edits = parseV4a(patchLineList);
    else edits = parseJson(patchText, patchLineList);
    if (edits.length === 0) throw new ParseProblem(1);
  } catch (e) {
    if (e instanceof ParseProblem) return { code: 2, outLines: [`error: parse ${e.atLine}`] };
    throw e;
  }

  const tree = new VirtualTree();
  const opts: RunOptions = { strict };
  const moves: Array<[string, string]> = [];
  const failures: EditProblem[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    const movesBefore = moves.length;
    try {
      edit(tree, opts, moves);
    } catch (e) {
      if (!(e instanceof EditProblem)) throw e;
      tree.restore(snap);
      moves.length = movesBefore;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    const lines = failures.map((f) => `error: ${f.kind} ${f.target}`);
    lines.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, outLines: lines };
  }

  // Summarise what changed. A successful move whose endpoints line up with
  // a deletion plus a creation is reported as one R line, sorted by the new
  // path; every other change keeps its own path as the sort key.
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const changedPaths: string[] = [];
  for (const p of tree.overlay.keys()) {
    if (tree.readOriginal(p) !== tree.overlay.get(p)) changedPaths.push(p);
  }
  const consumed = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    const oldGone = changedPaths.includes(oldP) && tree.read(oldP) === null && tree.readOriginal(oldP) !== null;
    const newBorn = changedPaths.includes(newP) && tree.readOriginal(newP) === null && tree.read(newP) !== null;
    if (oldGone && newBorn) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of changedPaths) {
    if (consumed.has(p)) continue;
    const was = tree.readOriginal(p);
    const now = tree.read(p);
    const tag = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ key: p, text: `${tag} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));

  if (!checkOnly) {
    for (const p of changedPaths) {
      const now = tree.read(p);
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  const summary = rows.length === 1 ? 'ok: 1 file' : `ok: ${rows.length} files`;
  return { code: 0, outLines: [...rows.map((r) => r.text), summary] };
}

// Entry point: inside a trial the kit runner drives this file check by
// check; otherwise the command line above runs once.
const trialUrl = process.env.MAKEFUN_ENV_URL;
if (trialUrl !== undefined && trialUrl !== '') {
  const runner = await import('./runner.ts');
  await runner.runTrial(trialUrl);
} else {
  const outcome = execute(process.argv.slice(2));
  writeSync(1, outcome.outLines.map((l) => `${l}\n`).join(''));
  process.exitCode = outcome.code;
}
