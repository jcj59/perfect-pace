/**
 * Pure elevation math on a profile given as parallel arrays of distance along the course and
 * elevation, both in meters: spike removal and smoothing, grades, and gain/loss with hysteresis.
 * Nothing here knows where the elevations came from (GPS or DEM, see `elevation-profile.ts`).
 *
 * Why this pipeline: raw elevation is noisy in two different ways. GPS altitude jitters by a few
 * meters from fix to fix, and both GPS and DEM data have occasional spikes (a bad fix, a bridge
 * deck or building edge sampled in the DEM). Summing raw positive differences turns that jitter
 * into hundreds of meters of fake climbing over a marathon. So:
 *
 * 1. A distance-based **median** filter removes spikes. A median ignores outliers entirely as long
 *    as they cover less than half the window, where an average would smear them into a bump.
 * 2. A distance-based **Gaussian** average removes the remaining jitter. Gaussian weights roll off
 *    smoothly, so the result has no ringing or corners and its grade is smooth too.
 * 3. Gain and loss are summed with a **hysteresis** threshold, so whatever wiggle survives
 *    smoothing (under the threshold) never counts, while real climbs count in full.
 *
 * Windows are in meters, not points, so they mean the same thing at any spacing, and a short last
 * interval (from resampling) gets its proper, small weight.
 */

/** Median filter window: 50 m, so spikes up to about 20 m long (two points at 10 m) vanish. */
export const DEFAULT_MEDIAN_WINDOW_M = 50;

/**
 * Gaussian smoothing standard deviation: 30 m. Bumps much shorter than about 100 m are mostly
 * flattened (they are noise, or too short to change a runner's pace), a 200 m climb keeps about 80%
 * of its height and a 1 km climb all of it. A runner's effort follows grade over tens of seconds,
 * not over 10 m. A wider window would cut noise further but also shave real short hills; 30 m is
 * where the synthetic tests recover both a 1 km and a 600 m hill within a few percent.
 */
export const DEFAULT_SMOOTHING_SIGMA_M = 30;

/**
 * Grades are clamped to +/-30%. Road and trail running courses rarely exceed 20 to 25% for any
 * real distance; steeper values are leftover artifacts (a cliff edge in the DEM, a tunnel), and an
 * unclamped one would dominate a pace model that grows quickly with grade.
 */
export const MAX_ABS_GRADE = 0.3;

/**
 * Gain/loss hysteresis threshold: 3 m. GPS jitter of about 1.5 m per fix still wanders by about
 * 0.5 m (one standard deviation) after smoothing. Its swings pass 2 m every few kilometers, which
 * would add phantom climbing on a flat course, but rarely pass 3 m (the synthetic tests measure
 * this). What a 3 m threshold can miss is a lone rise smaller than 3 m: an overpass, not a hill.
 */
export const DEFAULT_GAIN_THRESHOLD_M = 3;

/** Smoothing options, in meters along the course. */
export interface SmoothingOptions {
  /** Full width of the median filter window. 0 skips it. Default `DEFAULT_MEDIAN_WINDOW_M`. */
  medianWindowM?: number;
  /** Gaussian standard deviation. 0 skips it. Default `DEFAULT_SMOOTHING_SIGMA_M`. */
  sigmaM?: number;
}

function assertProfile(distM: ArrayLike<number>, eleM: ArrayLike<number>, fn: string): void {
  if (distM.length !== eleM.length) {
    throw new RangeError(`${fn}: ${distM.length} distances but ${eleM.length} elevations`);
  }
  for (let i = 0; i < eleM.length; i++) {
    const d = distM[i] as number;
    if (!Number.isFinite(eleM[i]) || !Number.isFinite(d) || (i > 0 && d < (distM[i - 1] as number))) {
      throw new RangeError(`${fn}: point ${i} has a non-finite value or a decreasing distance`);
    }
  }
}

function assertWidth(value: number, name: string, fn: string): void {
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new RangeError(`${fn}: ${name} must be a non-negative number of meters, got ${value}`);
  }
}

/**
 * Median of each point's neighborhood within `windowM / 2` meters on either side. Works for any
 * spacing; a window that holds an even number of points takes the mean of the middle two.
 */
export function medianFilter(distM: ArrayLike<number>, eleM: ArrayLike<number>, windowM: number): number[] {
  assertProfile(distM, eleM, "medianFilter");
  assertWidth(windowM, "windowM", "medianFilter");
  const n = eleM.length;
  const half = windowM / 2;
  const out = new Array<number>(n);
  const window: number[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const d = distM[i] as number;
    while ((distM[lo] as number) < d - half) lo++;
    while (hi < n && (distM[hi] as number) <= d + half) hi++;
    window.length = 0;
    for (let j = lo; j < hi; j++) window.push(eleM[j] as number);
    window.sort((a, b) => a - b);
    const m = window.length >> 1;
    out[i] = window.length % 2 ? (window[m] as number) : ((window[m - 1] as number) + (window[m] as number)) / 2;
  }
  return out;
}

/**
 * Gaussian-weighted average of each point's neighborhood, weight `exp(-x^2 / (2 sigma^2))` by the
 * distance `x` along the course, cut off at 3 sigma. Near the ends the window is one-sided and the
 * weights are renormalized, so the ends are not pulled toward zero.
 */
export function gaussianSmooth(distM: ArrayLike<number>, eleM: ArrayLike<number>, sigmaM: number): number[] {
  assertProfile(distM, eleM, "gaussianSmooth");
  assertWidth(sigmaM, "sigmaM", "gaussianSmooth");
  const n = eleM.length;
  if (sigmaM === 0) return Array.from(eleM);
  const reach = 3 * sigmaM;
  const k = -1 / (2 * sigmaM * sigmaM);
  const out = new Array<number>(n);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const d = distM[i] as number;
    while ((distM[lo] as number) < d - reach) lo++;
    let sum = 0;
    let weights = 0;
    for (let j = lo; j < n; j++) {
      const x = (distM[j] as number) - d;
      if (x > reach) break;
      const w = Math.exp(k * x * x);
      sum += w * (eleM[j] as number);
      weights += w;
    }
    out[i] = sum / weights;
  }
  return out;
}

/** The median filter, then the Gaussian average (see the module doc for why both). */
export function smoothElevations(
  distM: ArrayLike<number>,
  eleM: ArrayLike<number>,
  options: SmoothingOptions = {},
): number[] {
  const { medianWindowM = DEFAULT_MEDIAN_WINDOW_M, sigmaM = DEFAULT_SMOOTHING_SIGMA_M } = options;
  return gaussianSmooth(distM, medianFilter(distM, eleM, medianWindowM), sigmaM);
}

/**
 * The grade (rise over run, so 0.05 is 5%) of each interval `i..i + 1`, clamped to
 * `+/-maxAbsGrade`. A zero-length interval has grade 0. The result has one entry fewer than the
 * profile.
 */
export function computeGrades(
  distM: ArrayLike<number>,
  eleM: ArrayLike<number>,
  maxAbsGrade = MAX_ABS_GRADE,
): number[] {
  assertProfile(distM, eleM, "computeGrades");
  if (!(maxAbsGrade >= 0)) throw new RangeError(`computeGrades: invalid maxAbsGrade ${maxAbsGrade}`);
  const grades: number[] = [];
  for (let i = 1; i < eleM.length; i++) {
    const run = (distM[i] as number) - (distM[i - 1] as number);
    const grade = run > 0 ? ((eleM[i] as number) - (eleM[i - 1] as number)) / run : 0;
    grades.push(Math.min(maxAbsGrade, Math.max(-maxAbsGrade, grade)));
  }
  return grades;
}

/** Total climbing and descending in meters. */
export interface GainLoss {
  gainM: number;
  lossM: number;
}

/**
 * Total gain and loss with a hysteresis threshold, counting from turning point to turning point.
 *
 * A turning point is only confirmed once the elevation has moved `thresholdM` back from it: going
 * up, we track the highest point so far, and only when the profile drops `thresholdM` below it is
 * that peak final, adding `peak - previous valley` to the gain. So a wiggle smaller than the
 * threshold never reverses the direction and never counts, while a real climb counts in full,
 * from its exact bottom to its exact top.
 *
 * This differs on purpose from the simpler dead band ("count a change once it exceeds the
 * threshold, then move the reference"), which drops up to one threshold of every climb: with 5 m
 * of dead band, a 12 m hill counts as 10 m.
 *
 * The leg in progress at the end counts too (it has already moved at least `thresholdM`), so a
 * course that ends partway up a climb still gets that climb.
 */
export function gainLoss(eleM: ArrayLike<number>, thresholdM = DEFAULT_GAIN_THRESHOLD_M): GainLoss {
  assertWidth(thresholdM, "thresholdM", "gainLoss");
  let gainM = 0;
  let lossM = 0;
  if (eleM.length === 0) return { gainM, lossM };
  // Before the first turning point is confirmed, both the lowest and highest point so far are
  // candidates; the first `thresholdM` move picks one as the anchor, and a smaller wobble at the
  // start counts neither way.
  let lo = eleM[0] as number;
  let hi = lo;
  let anchor = lo; // the last confirmed turning point
  let extreme = lo; // the highest (going up) or lowest (going down) point since the anchor
  let direction = 0; // 1 up, -1 down, 0 not yet decided
  for (let i = 1; i < eleM.length; i++) {
    const e = eleM[i] as number;
    if (!Number.isFinite(e)) throw new RangeError(`gainLoss: point ${i} has a non-finite elevation ${e}`);
    if (direction === 0) {
      lo = Math.min(lo, e);
      hi = Math.max(hi, e);
      if (hi - lo >= thresholdM) {
        direction = e === hi ? 1 : -1;
        anchor = direction === 1 ? lo : hi;
        extreme = e;
      }
    } else if (direction === 1) {
      if (e > extreme) extreme = e;
      else if (extreme - e >= thresholdM) {
        gainM += extreme - anchor;
        anchor = extreme;
        extreme = e;
        direction = -1;
      }
    } else if (e < extreme) extreme = e;
    else if (e - extreme >= thresholdM) {
      lossM += anchor - extreme;
      anchor = extreme;
      extreme = e;
      direction = 1;
    }
  }
  if (direction === 1) gainM += extreme - anchor;
  else if (direction === -1) lossM += anchor - extreme;
  return { gainM, lossM };
}

/** Headline elevation numbers for a course. */
export interface ElevationStats extends GainLoss {
  minM: number;
  maxM: number;
}

/** Gain and loss (see `gainLoss`) plus the minimum and maximum. Throws on an empty profile. */
export function elevationStats(eleM: ArrayLike<number>, thresholdM = DEFAULT_GAIN_THRESHOLD_M): ElevationStats {
  if (eleM.length === 0) throw new RangeError("elevationStats: the profile is empty");
  let minM = Infinity;
  let maxM = -Infinity;
  for (let i = 0; i < eleM.length; i++) {
    minM = Math.min(minM, eleM[i] as number);
    maxM = Math.max(maxM, eleM[i] as number);
  }
  return { ...gainLoss(eleM, thresholdM), minM, maxM };
}
