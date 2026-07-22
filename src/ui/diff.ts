/** Pure line-based diff for the preview cards. */

export interface DiffOp {
  type: "same" | "add" | "del";
  text: string;
}

/** Above this many lines per side, fall back to whole-replace (O(n·m) guard). */
const MAX_LINES = 3000;

/**
 * Classic LCS line diff. Small and dependency-free; vault notes are well
 * within the size guard, and the preview only needs honest add/del/same runs,
 * not char-level refinement.
 */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ type: "del", text }) as DiffOp),
      ...b.map((text) => ({ type: "add", text }) as DiffOp),
    ];
  }

  // LCS table (lengths only).
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] });
  while (j < m) ops.push({ type: "add", text: b[j++] });
  return ops;
}

export type CompactOp = DiffOp | { type: "skip"; count: number };

/**
 * Collapse long unchanged runs for display: keep `context` lines of "same"
 * adjacent to each edit, replace the middle with a skip marker.
 */
export function compactDiff(ops: DiffOp[], context = 2): CompactOp[] {
  const out: CompactOp[] = [];
  let run: DiffOp[] = [];
  let seenEdit = false;

  const flush = (isTrailing: boolean) => {
    if (run.length === 0) return;
    // Keep the tail of a run leading into an edit, and the head of a run
    // following one; a run at either extreme edge needs only one side.
    const keepFront = seenEdit ? context : 0;
    const keepBack = isTrailing ? 0 : context;
    if (run.length <= keepFront + keepBack + 1) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, keepFront));
      out.push({ type: "skip", count: run.length - keepFront - keepBack });
      if (keepBack > 0) out.push(...run.slice(run.length - keepBack));
    }
    run = [];
  };

  for (const op of ops) {
    if (op.type === "same") {
      run.push(op);
    } else {
      flush(false);
      seenEdit = true;
      out.push(op);
    }
  }
  flush(true);
  return out;
}
