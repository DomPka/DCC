// Optimal linear assignment (Hungarian / Kuhn-Munkres with potentials), O(n^3).
// Mirrors lap.lapjv(cost, extend_cost=True, cost_limit=L) as used by ByteTrack:
// the matrix is extended with dummy rows/cols costing L/2, so a pair is only
// matched when that is cheaper than leaving both sides unmatched.

/**
 * @param {Float64Array|number[]} cost row-major nRows x nCols
 * @param {number} nRows
 * @param {number} nCols
 * @param {number} costLimit pairs with cost > costLimit are never matched
 * @returns {{matches: Array<[number, number]>, unmatchedRows: number[], unmatchedCols: number[]}}
 */
export function linearAssignment(cost, nRows, nCols, costLimit = Infinity) {
  const matches = [];
  if (nRows === 0 || nCols === 0) {
    return { matches, unmatchedRows: range(nRows), unmatchedCols: range(nCols) };
  }

  const limited = Number.isFinite(costLimit);
  const n = limited ? nRows + nCols : Math.max(nRows, nCols);
  const half = limited ? costLimit / 2 : 0;
  const BIG = 1e9;

  // Build a square matrix (1-indexed internally by the solver).
  const a = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let c;
      if (i < nRows && j < nCols) c = cost[i * nCols + j];
      else if (!limited) c = 0; // padding for rectangular, unlimited case
      else if (i >= nRows && j >= nCols) c = 0;
      else c = half;
      a[i * n + j] = Number.isFinite(c) ? c : BIG;
    }
  }

  const rowOfCol = solveSquare(a, n);

  const rowMatched = new Uint8Array(nRows);
  const colMatched = new Uint8Array(nCols);
  for (let j = 0; j < nCols; j++) {
    const i = rowOfCol[j];
    if (i >= 0 && i < nRows) {
      const c = cost[i * nCols + j];
      if (!(c > costLimit) && Number.isFinite(c)) {
        matches.push([i, j]);
        rowMatched[i] = 1;
        colMatched[j] = 1;
      }
    }
  }
  const unmatchedRows = [];
  const unmatchedCols = [];
  for (let i = 0; i < nRows; i++) if (!rowMatched[i]) unmatchedRows.push(i);
  for (let j = 0; j < nCols; j++) if (!colMatched[j]) unmatchedCols.push(j);
  matches.sort((x, y) => x[0] - y[0]);
  return { matches, unmatchedRows, unmatchedCols };
}

// Classic e-maxx Hungarian on an n x n matrix. Returns rowOfCol (0-indexed).
function solveSquare(a, n) {
  const INF = Infinity;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  const minv = new Float64Array(n + 1);
  const used = new Uint8Array(n + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(INF);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      const rowBase = (i0 - 1) * n - 1;
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[rowBase + j] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const rowOfCol = new Int32Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] > 0) rowOfCol[j - 1] = p[j] - 1;
  return rowOfCol;
}

function range(n) {
  const r = new Array(n);
  for (let i = 0; i < n; i++) r[i] = i;
  return r;
}
