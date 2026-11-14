/**
 * Exact segmented least squares: split a sequence into at most `K` contiguous pieces with one
 * constant value each, minimizing the weighted squared error. This is the heart of the pacing plan.
 *
 * ## The problem
 *
 * The course is cut into `n` intervals with lengths `w_i` (the weights) and ideal paces `o_i` from
 * the pace model. A plan gives every interval a pace `p_i` that is constant within each of at most
 * `K` contiguous pieces, and we minimize
 *
 *     E(p) = sum_i w_i (p_i - o_i)^2
 *
 * Weighting by length means a mile of being off by 5 s/mi costs the same wherever it is, however
 * finely that mile was sampled. Squaring makes one big miss (holding flat pace up a steep hill)
 * cost far more than several small ones, which is what a runner feels.
 *
 * ## Why the goal time takes care of itself
 *
 * The plan must also finish in the goal time, `sum_i w_i p_i = goal`. It looks like a constraint we
 * have to enforce, but it is satisfied automatically. Fix the partition into pieces. Within a piece
 * `P`, `E` is a one-variable quadratic in that piece's pace `c`: `sum_{i in P} w_i (c - o_i)^2`. Its
 * derivative is `2 sum w_i (c - o_i)`, which is zero at the length-weighted mean
 * `c = sum w_i o_i / sum w_i`. Then the piece's time is `c * sum w_i = sum w_i o_i`: exactly the
 * ideal time over that piece. Add up the pieces and the plan's time is `sum_i w_i o_i`, which the
 * pace model already made equal to the goal. So the unconstrained optimum is feasible, and therefore
 * also the constrained optimum. (In optimization terms: the constraint's Lagrange multiplier is
 * zero.) This only holds because the error is weighted by the same lengths that define time. With
 * an unweighted error, as in the original project, each piece's best pace is the plain mean of its
 * points, which over unevenly spaced points does not add up to the goal, hence its explicit
 * constraint.
 *
 * ## Why dynamic programming and not the original LP
 *
 * The original project wrote this as a mixed-integer program for Gurobi: a continuous pace per
 * interval, a 0/1 "pace changes here" variable per boundary, big-M constraints tying them, and an
 * explicit time constraint. That is a general integer program, which is NP-hard in general, needs
 * a commercial solver (none runs in a browser), and comes back with whatever the solver found in its
 * time limit, its optimality depending on how well the big-M was chosen.
 *
 * The problem has much more structure than a general MILP, though. Once the time constraint is
 * known to be automatic, all that is left is choosing where the at most `K - 1` breakpoints go, and
 * the error is a sum over pieces, each depending only on its own endpoints. That is the textbook
 * shape for dynamic programming. Let `E_k[j]` be the least error covering the first `j` intervals
 * with at most `k` pieces. The last piece starts at some `i < j`, and whatever came before it must
 * itself be optimal, so
 *
 *     E_1[j] = cost(0, j)
 *     E_k[j] = min( E_{k-1}[j],  min_{0 < i < j} E_{k-1}[i] + cost(i, j) )
 *
 * where `cost(i, j)` is the error of one piece over intervals `i..j-1` at its weighted mean.
 * Expanding the square, that error is `S2 - S1^2 / W` with `W = sum w`, `S1 = sum w o` and
 * `S2 = sum w o^2` over the piece, and prefix sums of `w`, `w o` and `w o^2` give each of those in
 * O(1). So the whole table costs `O(K n^2)` time, and its answer is the exact global optimum, not an
 * approximation. As a bonus, the table holds the optimum for every `k <= K` at once, which is the
 * "error vs number of pace changes" curve for free.
 *
 * ## A minimum piece length
 *
 * Optionally every piece must weigh at least `minPieceWeight` (in the plan, a length in meters):
 * the inner minimum just skips the `i` whose piece would be too short. No extra cost.
 *
 * ## An exact speedup: pruning starts that can never win
 *
 * Done naively, the inner minimum looks at every earlier `i`, about `K n^2 / 2` piece costs: some
 * 90 million for a marathon at 10 m spacing and 11 pieces, too slow to recompute while a slider
 * moves. But almost all of those starts can be ruled out for good, without changing the answer,
 * by the functional pruning of Rigaill's pDPA (the "pruned dynamic programming algorithm" for
 * change point detection):
 *
 * - Within one layer `k`, view each candidate start `i` as a function of the last piece's pace
 *   `mu`: `q_i(mu) = E_{k-1}[i] + sum_{t = i}^{j - 1} w_t (o_t - mu)^2`. Its minimum over `mu` is
 *   `E_{k-1}[i] + cost(i, j)`, exactly what the recurrence compares.
 * - As `j` grows, every `q_i` gains the same terms, so the differences between candidates never
 *   change. Equivalently, `q_i(mu) = r_i(mu) + G_j(mu)`, with a common `G_j` and a fixed
 *   `r_i(mu) = E_{k-1}[i] - sum_{t < i} w_t (o_t - mu)^2` (a downward parabola) per candidate.
 * - So keep the lower envelope of the `r_i`: for each `mu`, which candidate is lowest. A candidate
 *   that is not lowest anywhere is beaten, at every possible pace, by one still in the envelope,
 *   now and at every later `j`. It can never be the optimal start again and is dropped for good.
 *   Only paces within the range of `o` matter, because a piece's mean lies within it.
 *
 * On real courses only a few dozen candidates stay in the envelope, so a layer costs about
 * `O(n)` piece costs instead of `O(n^2)`, and the result is still the exact optimum (the tests
 * check it against brute force). The worst case remains `O(K n^2)`.
 */

/** Options for `segmentLeastSquares`. */
export interface SegmentationOptions {
  /** The most pieces allowed, `K >= 1`. The result has one entry for every `k` from 1 to `K`. */
  maxPieces: number;
  /**
   * Every piece must have at least this total weight (default 0). A single piece covering
   * everything is always allowed, even when it is lighter.
   */
  minPieceWeight?: number;
}

/** The optimal segmentation with at most `k` pieces. */
export interface Segmentation {
  /** The `k` this is the optimum for (the most pieces allowed). */
  maxPieces: number;
  /** Piece boundaries as indexes: `[0, b_1, ..., n]`, so piece `p` covers `bounds[p]..bounds[p + 1] - 1`. */
  bounds: number[];
  /** Each piece's weighted mean value, the optimal constant for it. */
  values: number[];
  /** The minimized `sum_i w_i (p_i - o_i)^2`. */
  error: number;
}

/**
 * Splits gaining less than this share of the data's scale (`sum_i w_i o_i^2`) are rounding noise,
 * not improvements, so a flat course with `K = 6` still gets one piece.
 */
const RELATIVE_TOLERANCE = 1e-12;

function assertInputs(values: ArrayLike<number>, weights: ArrayLike<number>, options: SegmentationOptions): void {
  if (values.length !== weights.length) {
    throw new RangeError(`segmentLeastSquares: ${values.length} values but ${weights.length} weights`);
  }
  if (values.length === 0) throw new RangeError("segmentLeastSquares: nothing to segment");
  if (!(Number.isInteger(options.maxPieces) && options.maxPieces >= 1)) {
    throw new RangeError(`segmentLeastSquares: maxPieces must be a positive integer, got ${options.maxPieces}`);
  }
  const minW = options.minPieceWeight ?? 0;
  if (!(Number.isFinite(minW) && minW >= 0)) {
    throw new RangeError(`segmentLeastSquares: invalid minPieceWeight ${minW}`);
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new RangeError(`segmentLeastSquares: value ${i} is not finite`);
    const w = weights[i] as number;
    if (!(Number.isFinite(w) && w >= 0)) throw new RangeError(`segmentLeastSquares: weight ${i} is invalid (${w})`);
  }
}

/**
 * The lower envelope of the candidates' `r_i(mu)` over a range of paces (see the module doc):
 * piece `p` spans `[from[p], from[p + 1]]` (the last one ends at `end`) and `owner[p]` is the
 * candidate start that is lowest there. Two sets of buffers, swapped on every insertion.
 */
interface Envelope {
  owner: Int32Array;
  from: Float64Array;
  nextOwner: Int32Array;
  nextFrom: Float64Array;
  count: number;
  start: number;
  end: number;
}

function newEnvelope(size: number, start: number, end: number): Envelope {
  return {
    owner: new Int32Array(size),
    from: new Float64Array(size),
    nextOwner: new Int32Array(size),
    nextFrom: new Float64Array(size),
    count: 0,
    start,
    end,
  };
}

/**
 * Insert candidate start `m`, later than every candidate already in the envelope, and drop the
 * ones it beats everywhere.
 *
 * For an older candidate `i < m`,
 *
 *     r_m(mu) - r_i(mu) = E_{k-1}[m] - E_{k-1}[i] - sum_{t = i}^{m - 1} w_t (o_t - mu)^2
 *                       = slack - W (mu - c)^2
 *
 * with `W`, `c` the weight and mean of `o[i..m)` and `slack = E_{k-1}[m] - E_{k-1}[i] - cost(i, m)`.
 * So `i` stays lower than `m` only on `[c - h, c + h]` with `h = sqrt(slack / W)` (nowhere when
 * `slack < 0`), and `m` takes over the rest. Doing that in each piece gives the new envelope.
 */
function insert(
  env: Envelope,
  m: number,
  prev: Float64Array,
  PW: Float64Array,
  P1: Float64Array,
  P2: Float64Array,
): void {
  const { owner, from, nextOwner, nextFrom } = env;
  let count = 0;
  // Append a piece, merging it into the previous one when the owner is the same.
  const push = (who: number, at: number): void => {
    if (count > 0 && nextOwner[count - 1] === who) return;
    nextOwner[count] = who;
    nextFrom[count] = at;
    count++;
  };
  if (env.count === 0) push(m, env.start);
  const eM = prev[m] as number;
  const wM = PW[m] as number;
  const s1M = P1[m] as number;
  const s2M = P2[m] as number;
  for (let p = 0; p < env.count; p++) {
    const i = owner[p] as number;
    const x0 = from[p] as number;
    const x1 = p + 1 < env.count ? (from[p + 1] as number) : env.end;
    const W = wM - (PW[i] as number);
    let lo = x0;
    let hi = x1;
    if (W > 0) {
      const s1 = s1M - (P1[i] as number);
      const c = s1 / W;
      const slack = eM - (prev[i] as number) - (s2M - (P2[i] as number) - s1 * c);
      if (slack >= 0) {
        const h = Math.sqrt(slack / W);
        if (c - h > lo) lo = c - h;
        if (c + h < hi) hi = c + h;
      } else hi = lo;
    } else if (!(eM - (prev[i] as number) >= 0)) hi = lo;
    if (lo < hi) {
      if (x0 < lo) push(m, x0);
      push(i, lo);
      if (hi < x1) push(m, hi);
    } else push(m, x0);
  }
  env.owner = nextOwner;
  env.from = nextFrom;
  env.nextOwner = owner;
  env.nextFrom = from;
  env.count = count;
}

/**
 * The optimal segmentation for every `k = 1..maxPieces` (index `k - 1`) of `values` weighted by
 * `weights`, by the dynamic program in the module doc. Each result is the exact global minimum of
 * the weighted squared error with at most `k` pieces, each at least `minPieceWeight` heavy. When
 * more pieces do not help (or cannot meet the minimum), the result for `k` reuses fewer.
 */
export function segmentLeastSquares(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
  options: SegmentationOptions,
): Segmentation[] {
  assertInputs(values, weights, options);
  const n = values.length;
  const K = options.maxPieces;

  // Center the values on their weighted mean before squaring: the piece cost `S2 - S1^2 / W` is a
  // difference of two large numbers, and centering keeps them small so less precision cancels.
  let totalW = 0;
  let totalWO = 0;
  let scale = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i] as number;
    const o = values[i] as number;
    totalW += w;
    totalWO += w * o;
    scale += w * o * o;
  }
  const mean = totalW > 0 ? totalWO / totalW : 0;
  const tol = RELATIVE_TOLERANCE * scale;
  const minW = options.minPieceWeight ?? 0;
  // Prefix sums compare lengths that were summed in different orders, so allow for rounding.
  const minWCheck = minW - 1e-9 * Math.max(minW, totalW * Number.EPSILON);

  const PW = new Float64Array(n + 1);
  const P1 = new Float64Array(n + 1);
  const P2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const w = weights[i] as number;
    const c = (values[i] as number) - mean;
    PW[i + 1] = (PW[i] as number) + w;
    P1[i + 1] = (P1[i] as number) + w * c;
    P2[i + 1] = (P2[i] as number) + w * c * c;
  }
  const cost = (i: number, j: number): number => {
    const W = (PW[j] as number) - (PW[i] as number);
    if (!(W > 0)) return 0;
    const s1 = (P1[j] as number) - (P1[i] as number);
    const c = (P2[j] as number) - (P2[i] as number) - (s1 * s1) / W;
    return c > 0 ? c : 0;
  };

  // errors[k - 1][j] is E_k[j]; starts[k - 1][j] is where the last piece starts, or -1 when the
  // optimum for k is the one for k - 1 (more pieces did not help).
  const errors: Float64Array[] = [];
  const starts: Int32Array[] = [];
  const first = new Float64Array(n + 1).fill(Infinity);
  first[0] = 0;
  for (let j = 1; j <= n; j++) {
    if ((PW[j] as number) >= minWCheck || j === n) first[j] = cost(0, j);
  }
  errors.push(first);
  starts.push(new Int32Array(n + 1));

  let muLo = Infinity;
  let muHi = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = (values[i] as number) - mean;
    if (c < muLo) muLo = c;
    if (c > muHi) muHi = c;
  }
  // Widen the range a little: it only has to contain every piece mean, and rounding can put a
  // mean a hair outside the extremes (or the range can be a single point, for constant values).
  const pad = (muHi - muLo) * 1e-6 + 1e-12;
  // A lower envelope of n downward parabolas has at most 2n - 1 pieces.
  const env = newEnvelope(2 * n + 2, muLo - pad, muHi + pad);
  for (let k = 2; k <= K; k++) {
    const prev = errors[k - 2] as Float64Array;
    const cur = new Float64Array(n + 1);
    const start = new Int32Array(n + 1).fill(-1);
    cur[0] = 0;
    // A start joins the envelope once it leaves the last piece at least `minW` heavy (that only
    // gets easier as `j` grows) and leaves it when it can never win again.
    env.count = 0;
    let next = 1; // the next start to admit
    for (let j = 1; j <= n; j++) {
      const W0 = PW[j] as number;
      const S10 = P1[j] as number;
      const S20 = P2[j] as number;
      while (next < j && W0 - (PW[next] as number) >= minWCheck) {
        insert(env, next++, prev, PW, P1, P2);
      }
      const owners = env.owner;
      const fewer = prev[j] as number;
      let best = Infinity;
      let bestI = -1;
      let bound = fewer - tol;
      for (let p = 0; p < env.count; p++) {
        const i = owners[p] as number;
        const e = prev[i] as number;
        if (e >= bound) continue;
        // cost(i, j), inlined: this loop and `insert` are the whole running time.
        const W = W0 - (PW[i] as number);
        let c = 0;
        if (W > 0) {
          const s1 = S10 - (P1[i] as number);
          c = S20 - (P2[i] as number) - (s1 * s1) / W;
          if (c < 0) c = 0;
        }
        const total = e + c;
        if (total < best) {
          best = total;
          bestI = i;
          if (best < bound) bound = best;
        }
      }
      if (bestI >= 0 && best < fewer - tol) {
        cur[j] = best;
        start[j] = bestI;
      } else cur[j] = fewer;
    }
    errors.push(cur);
    starts.push(start);
  }

  const results: Segmentation[] = [];
  for (let k = 1; k <= K; k++) {
    const bounds = [n];
    let j = n;
    let layer = k;
    while (layer >= 1 && j > 0) {
      if (layer === 1) {
        bounds.push(0);
        break;
      }
      const s = (starts[layer - 1] as Int32Array)[j] as number;
      if (s >= 0) {
        bounds.push(s);
        j = s;
      }
      layer--;
    }
    bounds.reverse();
    // Each piece's mean straight from the inputs, which is exact for a constant piece.
    const pieceValues: number[] = [];
    for (let p = 0; p + 1 < bounds.length; p++) {
      let W = 0;
      let S = 0;
      for (let i = bounds[p] as number; i < (bounds[p + 1] as number); i++) {
        W += weights[i] as number;
        S += (weights[i] as number) * (values[i] as number);
      }
      pieceValues.push(W > 0 ? S / W : mean);
    }
    results.push({ maxPieces: k, bounds, values: pieceValues, error: (errors[k - 1] as Float64Array)[n] as number });
  }
  return results;
}
