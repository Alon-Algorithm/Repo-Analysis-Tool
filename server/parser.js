// server/parser.js
//
// Streaming parser for the single-pass repository extraction:
//
//   git log --no-merges --use-mailmap -M50% --numstat -z --format=...
//
// Wire format (verified byte-for-byte against git 2.43):
//
//   commit header  "@@" <sha> US <parents> US <ct> US <an> US <ae> US <aN> US <aE> NUL
//   file entry     <added> TAB <removed> TAB <path> NUL
//   binary entry   "-" TAB "-" TAB <path> NUL            (never measured, still counted as an object)
//   rename entry   <added> TAB <removed> TAB NUL <oldPath> NUL <newPath> NUL
//   empty commit   header NUL directly followed by the next header
//   separator      a single LF follows a header whenever the commit has entries
//
// US is the ASCII unit separator (0x1F); NUL (0x00) terminates every record.
// Paths are raw UTF-8: no quoting, tabs/newlines inside paths are preserved.

const NUL = 0;
const US = '\x1f';

/**
 * Arguments for the single extraction pass, parseable by GitLogParser.
 * mailmapBlob: optional `<commit-ish>:.mailmap` source; when omitted git's
 * default applies (worktree .mailmap, or HEAD:.mailmap for bare repositories).
 */
export function logArgs(ref = 'HEAD', { mailmapBlob = null } = {}) {
  const args = [];
  if (mailmapBlob) args.push('-c', `mailmap.blob=${mailmapBlob}:.mailmap`);
  args.push(
    'log',
    '--no-merges', // H-bar: only non-merge commits
    '--use-mailmap', // %aN/%aE are canonical identities; %an/%ae stay raw
    '-M50%', // rename detection at 50%
    '--numstat',
    '-z',
    '--format=@@%H%x1f%P%x1f%ct%x1f%an%x1f%ae%x1f%aN%x1f%aE',
    ref,
  );
  return args;
}

function parseCount(text, record) {
  if (text === '-') return null; // binary: listed, but not measured
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`malformed numstat count "${text}" in record: ${JSON.stringify(record)}`);
  }
  return n;
}

/**
 * Incremental parser: feed raw `git log` stdout chunks in push(); records are
 * emitted as soon as their terminating NUL arrives, so memory stays O(record).
 *
 * Handlers:
 *   onCommit({ sha, parents, ct, an, ae, aN, aE })
 *   onEntry ({ added, removed, path, oldPath })  added/removed: number | null (binary)
 *                                                oldPath: rename source or null
 */
export class GitLogParser {
  #onCommit;
  #onEntry;
  #buf = Buffer.alloc(0);
  #afterHeader = false;
  #renameState = null; // null | 'awaiting-old' | 'awaiting-new'
  #renameAdded = 0;
  #renameRemoved = 0;
  #renameOld = '';

  constructor({ onCommit, onEntry } = {}) {
    this.#onCommit = onCommit;
    this.#onEntry = onEntry;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk, 'utf8');
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    this.#drain();
  }

  end() {
    if (this.#buf.length > 0) {
      throw new Error(`truncated git log stream (${this.#buf.length} trailing bytes)`);
    }
    if (this.#renameState !== null) {
      throw new Error('truncated git log stream (incomplete rename record)');
    }
  }

  #drain() {
    let pos = 0;
    for (;;) {
      const nul = this.#buf.indexOf(NUL, pos);
      if (nul === -1) break;
      this.#handleRecord(this.#buf.toString('utf8', pos, nul));
      pos = nul + 1;
    }
    if (pos > 0) this.#buf = this.#buf.subarray(pos);
  }

  #handleRecord(record) {
    // rename continuations: the next two records are the old and new paths
    if (this.#renameState === 'awaiting-old') {
      this.#renameOld = record;
      this.#renameState = 'awaiting-new';
      return;
    }
    if (this.#renameState === 'awaiting-new') {
      this.#renameState = null;
      this.#emitEntry({
        added: this.#renameAdded,
        removed: this.#renameRemoved,
        path: record,
        oldPath: this.#renameOld,
      });
      return;
    }

    // a header is joined to its entries by a single LF (absent on empty commits)
    if (this.#afterHeader && record.charCodeAt(0) === 10) record = record.slice(1);
    this.#afterHeader = false;

    if (record.charCodeAt(0) === 64 && record.charCodeAt(1) === 64) {
      this.#handleHeader(record.slice(2));
      return;
    }
    this.#handleEntry(record);
  }

  #handleHeader(body) {
    const f = body.split(US);
    if (f.length !== 7) {
      throw new Error(`malformed commit header (${f.length} fields): ${JSON.stringify(body)}`);
    }
    const [sha, parents, ct, an, ae, aN, aE] = f;
    const commit = {
      sha,
      parents: parents === '' ? [] : parents.split(' '),
      ct: Number(ct),
      an, // author name, raw
      ae, // author email, raw
      aN, // canonical name (.mailmap applied)
      aE, // canonical email (.mailmap applied)
    };
    if (!Number.isInteger(commit.ct)) {
      throw new Error(`malformed committer timestamp: ${JSON.stringify(ct)}`);
    }
    this.#afterHeader = true;
    if (this.#onCommit) this.#onCommit(commit);
  }

  #handleEntry(record) {
    const t1 = record.indexOf('\t');
    const t2 = t1 === -1 ? -1 : record.indexOf('\t', t1 + 1);
    if (t2 === -1) {
      throw new Error(`malformed numstat record: ${JSON.stringify(record)}`);
    }
    const added = parseCount(record.slice(0, t1), record);
    const removed = parseCount(record.slice(t1 + 1, t2), record);
    const path = record.slice(t2 + 1);
    if (path === '') {
      // rename marker: empty path field, the two pathnames follow as records
      this.#renameState = 'awaiting-old';
      this.#renameAdded = added;
      this.#renameRemoved = removed;
      return;
    }
    this.#emitEntry({ added, removed, path, oldPath: null });
  }

  #emitEntry(entry) {
    if (this.#onEntry) this.#onEntry(entry);
  }
}

/**
 * One-shot convenience wrapper: parses a complete extraction buffer (or string)
 * into { commits, entries }. Optional handlers observe records while parsing.
 */
export function parseLog(data, { onCommit, onEntry } = {}) {
  const commits = [];
  const entries = [];
  const parser = new GitLogParser({
    onCommit: (c) => {
      commits.push(c);
      if (onCommit) onCommit(c);
    },
    onEntry: (e) => {
      entries.push(e);
      if (onEntry) onEntry(e);
    },
  });
  parser.push(data);
  parser.end();
  return { commits, entries };
}
