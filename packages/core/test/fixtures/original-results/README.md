# Original project results

`seg-plans.json` holds the pacing plans the original Cornell project committed under `results/*/SEG/*_segments.json`
([daniel-lee-user/perfect-pace](https://github.com/daniel-lee-user/perfect-pace), commit `83a5524`), one entry per
course with the goal in minutes and each segment's start and length in miles and pace per mile, copied unchanged
(numbers parsed from the original strings). They come from that project's hill-detection segmenter with an
unweighted objective, so `test/original-results.test.ts` only checks that our plans shift pace in the same
direction between consecutive original segments, never the exact values.
