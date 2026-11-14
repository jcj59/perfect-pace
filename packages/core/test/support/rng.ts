/**
 * Seeded PRNG (mulberry32) for randomized and property tests. Every randomized test takes a
 * fixed seed so a failure reproduces exactly; print the seed in the assertion message.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` uniform values in `[min, max)` from a seeded generator. */
export function randomValues(seed: number, count: number, min = 0, max = 1): number[] {
  const next = mulberry32(seed);
  return Array.from({ length: count }, () => min + (max - min) * next());
}
