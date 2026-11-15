import type { Page } from "@playwright/test";

/**
 * How fast this machine runs the kind of work a course load does, for timing budgets that must
 * hold on a mid-range laptop but run on CI runners whose CPUs vary by about 2x.
 *
 * The workload runs in the page (the same browser, process and CPU as the budgeted work) and
 * mimics a load: it writes and scans GPX-like text, parses numbers, allocates one small object
 * per point, sums haversine distances and packs the points into typed arrays. Its time is the
 * median of `runs` runs, after one warm-up, so a JIT tier-up or one preempted run does not skew it.
 */
export async function calibrationMs(page: Page, runs = 7): Promise<number> {
  return page.evaluate((count) => {
    const work = (): number => {
      let seed = 1;
      const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const parts: string[] = [];
      for (let i = 0; i < 50_000; i++) {
        const lat = (42.4 + random() * 0.1).toFixed(7);
        const lon = (-76.5 + random() * 0.1).toFixed(7);
        parts.push(`<trkpt lat="${lat}" lon="${lon}"><ele>${(200 + random() * 50).toFixed(1)}</ele></trkpt>`);
      }
      const text = parts.join("\n");
      const points: { lat: number; lon: number; ele: number }[] = [];
      for (let at = text.indexOf("<trkpt"); at >= 0; at = text.indexOf("<trkpt", at + 1)) {
        const latStart = text.indexOf('"', at) + 1;
        const latEnd = text.indexOf('"', latStart);
        const lonStart = text.indexOf('"', latEnd + 1) + 1;
        const lonEnd = text.indexOf('"', lonStart);
        const eleStart = text.indexOf("<ele>", lonEnd) + 5;
        const eleEnd = text.indexOf("<", eleStart);
        points.push({
          lat: Number(text.slice(latStart, latEnd)),
          lon: Number(text.slice(lonStart, lonEnd)),
          ele: Number(text.slice(eleStart, eleEnd).trim()),
        });
      }
      const rad = Math.PI / 180;
      const packed = new Float64Array(points.length * 3);
      let total = 0;
      points.forEach((p, i) => {
        packed[i * 3] = p.lat;
        packed[i * 3 + 1] = p.lon;
        packed[i * 3 + 2] = p.ele;
        const q = points[i - 1];
        if (!q) return;
        const dLat = (p.lat - q.lat) * rad;
        const dLon = (p.lon - q.lon) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(q.lat * rad) * Math.cos(p.lat * rad) * Math.sin(dLon / 2) ** 2;
        total += 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
      });
      return total + (packed[packed.length - 1] ?? 0);
    };
    work();
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      if (!(work() > 0)) throw new Error("the calibration workload went wrong");
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)] as number;
  }, runs);
}

/**
 * `calibrationMs` on the reference machine, the one the plan's budgets are for. Measured on the
 * CI runners' EPYC 9V74 (40 to 46 ms, the most common runner), whose single-core speed is about
 * that of a mid-range laptop; a recent high-end laptop takes about 25 ms.
 */
export const REFERENCE_CALIBRATION_MS = 45;
/**
 * The most headroom a slow machine gets. The slowest runners seen (EPYC 7763) calibrate at about
 * 1.25x the reference; past 2x the machine is too slow (or too busy) to say anything about the budget.
 */
export const MAX_HEADROOM = 2;

/** How much longer than the reference a budget may take on a machine with this calibration. */
export function loadHeadroom(calibration: number): number {
  return Math.min(MAX_HEADROOM, Math.max(1, calibration / REFERENCE_CALIBRATION_MS));
}
