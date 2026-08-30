// GLOBAL ASSIGNMENT — the Hungarian algorithm, implemented here rather than
// imported.
//
// WHY BY HAND. Not because a library would be slower — it would not — but
// because this is the one decision in the system a dispatcher is most likely
// to challenge ("why did the van two streets away go to the other job?"), and
// an answer that bottoms out at "the library said so" is not an answer. The
// implementation below is about eighty lines and every one of them is
// explainable.
//
// WHAT PROBLEM THIS SOLVES, AND WHY GREEDY IS NOT ENOUGH.
// Assigning each job its own best option one at a time is greedy, and greedy
// strands jobs: the first job takes the only EV-certified unit because it is
// marginally better there, and the genuinely-EV job later in the list gets
// nothing. The Hungarian algorithm finds the assignment minimising TOTAL cost
// across all jobs at once, so it will happily give job A its second choice to
// keep job B servable at all.
//
// HOW IT WORKS, in the terms the code below uses.
// Each row (job) and each column (unit) carries a POTENTIAL — `rowPotential`
// and `colPotential`. The reduced cost of a cell is
// `cost[i][j] - rowPotential[i] - colPotential[j]`, and the algorithm keeps
// every reduced cost at or above zero as an invariant. Linear-programming
// duality says that once every job is matched using only zero-reduced-cost
// cells, that matching is optimal — there is no cheaper one, and no further
// search is needed to prove it.
//
// So each job is added by searching for an augmenting path through the
// zero-reduced-cost cells (a Dijkstra-like sweep, cheapest first). When the
// search runs out of zero-cost edges to follow, the potentials are shifted by
// the smallest slack found (`delta`), which manufactures at least one new
// zero-cost cell without ever making an existing reduced cost negative. The
// search then continues. Every job is matched in turn, and the invariant
// guarantees the result is a minimum-cost assignment.

// ---------------------------------------------------------------------------
// A cell that cannot legally be used — the job and this unit have no feasible
// option between them (Phase 7 already rejected it, or none was generated).
//
// WHY A LARGE FINITE NUMBER AND NOT INFINITY: Infinity poisons the potential
// arithmetic — `Infinity - Infinity` is NaN and the algorithm silently stops
// making sense. A finite sentinel keeps every subtraction well-defined.
//
// WHY THIS IS NOT A DISGUISED CONSTRAINT (invariant 3). The distinction is
// real and worth stating precisely. A disguised constraint is a penalty that
// stands in for a RULE — "never send an uncertified technician" expressed as
// a big number, which some combination of other terms can eventually
// outweigh. Nothing of that kind happens here: feasibility ran first
// (feasibility.ts) and already removed every option that breaks a rule, so
// by the time a matrix is built there is no rule left for a number to
// encode. What UNAVAILABLE_COST represents is not "this is very bad" but
// "there is nothing here to choose" — the absence of an option, not a
// disfavoured one. Selecting such a cell is not a bad assignment the solver
// tolerated; it is the solver reporting the job unassigned, and
// `solveAssignment` translates it back to exactly that rather than letting it
// through as a decision.
export const UNAVAILABLE_COST = Number.MAX_SAFE_INTEGER / 4;

export type AssignmentResult = {
  // assignedColumn[row] is the column that row was matched to, or null when
  // the row ended up on a padding column or an unavailable cell — both of
  // which mean "this job gets nothing this round".
  assignedColumn: (number | null)[];
  // Sum of the real cells actually used. Padding and unavailable cells
  // contribute nothing, because they are not assignments.
  totalCost: number;
};

// ---------------------------------------------------------------------------
// The algorithm itself. Requires rows <= columns; `solveAssignment` below
// guarantees that by padding, and almost every caller should use that wrapper
// instead. Exported because its precondition is worth testing directly — see
// the guard below and the test that pins it.
//
// Returns, for each row, the column it matched. Indices are 1-based
// internally with a sentinel at 0, which is what lets the augmenting-path
// walk terminate on `column === 0` without a special case on every step. The
// public functions above and below are 0-based.
export function hungarian(cost: number[][], rows: number, cols: number): number[] {
  // A PRECONDITION WORTH CHECKING RATHER THAN ASSUMING. With more rows than
  // columns there is no column left for the last row to augment into, and the
  // inner `do…while` never reaches an unmatched column — the algorithm spins
  // forever instead of returning a wrong answer. An infinite loop is the
  // worst possible failure in a dispatch path: no error, no timeout, no
  // partial result, just a request that never comes back. `solveAssignment`
  // pads to guarantee this holds, and this throw is what makes a future edit
  // that breaks the padding fail in a millisecond rather than hang.
  if (rows > cols) {
    throw new Error(`hungarian requires rows <= cols, got ${rows}x${cols} (padding is missing)`);
  }

  const rowPotential = new Array<number>(rows + 1).fill(0);
  const colPotential = new Array<number>(cols + 1).fill(0);
  // rowMatchedToCol[j] is the row currently matched to column j; 0 means free.
  const rowMatchedToCol = new Array<number>(cols + 1).fill(0);
  // previousCol[j] reconstructs the augmenting path once one is found.
  const previousCol = new Array<number>(cols + 1).fill(0);

  for (let row = 1; row <= rows; row += 1) {
    rowMatchedToCol[0] = row;
    let currentCol = 0;

    // Cheapest known slack to each column, for this row's search only.
    const minSlack = new Array<number>(cols + 1).fill(Number.POSITIVE_INFINITY);
    const visited = new Array<boolean>(cols + 1).fill(false);

    // Grow the search until it reaches a column no row is matched to — that
    // column is the end of an augmenting path.
    do {
      visited[currentCol] = true;
      const currentRow = rowMatchedToCol[currentCol]!;
      let delta = Number.POSITIVE_INFINITY;
      let nextCol = 0;

      for (let col = 1; col <= cols; col += 1) {
        if (visited[col]) continue;

        const reduced = cost[currentRow - 1]![col - 1]! - rowPotential[currentRow]! - colPotential[col]!;
        if (reduced < minSlack[col]!) {
          minSlack[col] = reduced;
          previousCol[col] = currentCol;
        }
        if (minSlack[col]! < delta) {
          delta = minSlack[col]!;
          nextCol = col;
        }
      }

      // Shift potentials by the smallest slack found. This creates at least
      // one new zero-reduced-cost cell (the one that achieved `delta`) while
      // leaving every already-zero cell at zero — which is why the search can
      // continue without invalidating what it has already built.
      for (let col = 0; col <= cols; col += 1) {
        if (visited[col]) {
          const matchedRow = rowMatchedToCol[col]!;
          rowPotential[matchedRow] = rowPotential[matchedRow]! + delta;
          colPotential[col] = colPotential[col]! - delta;
        } else {
          minSlack[col] = minSlack[col]! - delta;
        }
      }

      currentCol = nextCol;
    } while (rowMatchedToCol[currentCol] !== 0);

    // Walk the path backwards, flipping matched and unmatched edges. This is
    // what actually adds one to the size of the matching.
    do {
      const previous = previousCol[currentCol]!;
      rowMatchedToCol[currentCol] = rowMatchedToCol[previous]!;
      currentCol = previous;
    } while (currentCol !== 0);
  }

  const assignedColumn = new Array<number>(rows).fill(-1);
  for (let col = 1; col <= cols; col += 1) {
    const row = rowMatchedToCol[col]!;
    if (row > 0) assignedColumn[row - 1] = col - 1;
  }
  return assignedColumn;
}

// ---------------------------------------------------------------------------
// PADDING, and why it is not a constraint either.
//
// The algorithm needs at least as many columns as rows. When there are more
// jobs than units, some jobs simply cannot be served this round — that is a
// real operational outcome, not an error and not a rule. Padding gives every
// job a column meaning "nothing assigned" so the matrix is solvable and the
// unserved jobs are reported honestly rather than the whole solve failing.
//
// One padding column per row is always enough (in the worst case every job
// goes unassigned) and costs nothing to over-provide.
export function solveAssignment(cost: number[][]): AssignmentResult {
  const rows = cost.length;
  if (rows === 0) return { assignedColumn: [], totalCost: 0 };

  const realCols = cost[0]!.length;
  const paddedCols = realCols + rows;

  const padded: number[][] = cost.map((row) => [
    ...row,
    ...new Array<number>(rows).fill(UNAVAILABLE_COST),
  ]);

  const assigned = hungarian(padded, rows, paddedCols);

  const assignedColumn: (number | null)[] = [];
  let totalCost = 0;

  for (let row = 0; row < rows; row += 1) {
    const col = assigned[row]!;
    const isPadding = col >= realCols;
    const isUnavailable = !isPadding && cost[row]![col]! >= UNAVAILABLE_COST;

    if (col < 0 || isPadding || isUnavailable) {
      assignedColumn.push(null);
      continue;
    }

    assignedColumn.push(col);
    totalCost += cost[row]![col]!;
  }

  return { assignedColumn, totalCost };
}
