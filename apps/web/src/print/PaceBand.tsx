import { type DistanceUnit, type Plan, formatDuration, formatPace, metersToUnit } from "@pp/core";
import { paceBand } from "../plan/export.ts";
import { roundPreservingSum } from "../plan/inputs.ts";
import { TONE_COLORS, segmentTone } from "../plan/tones.ts";

/** Rows per strip: a strip stays short enough to wrap around a wrist and fit the page. */
const MAX_ROWS_PER_STRIP = 30;

/** Print ink: always dark on white, whatever theme the screen is in. */
const INK = "#1c1917";
const MUTED = "#57534e";
const RULE = "#d6d3ce";

/**
 * The printed pace band, shown only when printing (the app hides itself in print; see
 * `styles.css`). One or more strips of the time to reach each mile or kilometer marker, with each
 * split and a stripe in the segment's color (where the pace changes is marked), then the plan's
 * segments with their paces and reasons. Colors are the light theme's, since paper is white.
 */
export function PaceBand({ plan, units, title }: { plan: Plan; units: DistanceUnit; title: string }) {
  const rows = paceBand(plan, units);
  const strips = Math.ceil(rows.length / MAX_ROWS_PER_STRIP);
  const perStrip = Math.ceil(rows.length / strips);
  const chunks = Array.from({ length: strips }, (_, i) => rows.slice(i * perStrip, (i + 1) * perStrip));
  const times = roundPreservingSum(plan.segments.map((s) => s.timeS));
  const finishS = times.reduce((a, b) => a + b, 0);
  const tones = TONE_COLORS.light;
  const unitWord = units === "mi" ? "Mile" : "Km";
  const decimals = metersToUnit(plan.lengthM, units) < 3 ? 2 : 1;
  const distance = (m: number) => metersToUnit(m, units).toFixed(decimals);

  return (
    <div className="pp-print hidden" style={{ color: INK }} data-testid="pace-band">
      <header className="flex items-end justify-between gap-6 pb-3" style={{ borderBottom: `2px solid ${INK}` }}>
        <div className="min-w-0">
          <p className="text-[9pt] font-semibold tracking-[0.12em] uppercase" style={{ color: MUTED }}>
            Pace band
          </p>
          <h1 className="text-[20pt] leading-tight font-bold tracking-tight">{title}</h1>
          <p className="mt-0.5 text-[10pt]" style={{ color: MUTED }}>
            {metersToUnit(plan.lengthM, units).toFixed(2)} {units} &middot; {plan.segments.length}{" "}
            {plan.segments.length === 1 ? "segment" : "segments"} &middot; flat-ground pace{" "}
            {formatPace(plan.flatPaceSPerM, units)} /{units}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[9pt] font-semibold tracking-[0.12em] uppercase" style={{ color: MUTED }}>
            Goal
          </p>
          <p className="text-[22pt] leading-tight font-bold tabular-nums" data-testid="band-goal">
            {formatDuration(finishS)}
          </p>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-start gap-[6mm]">
        {chunks.map((chunk, i) => (
          <table
            key={i}
            className="pp-band-strip border-separate border-spacing-0 text-[10pt] tabular-nums"
            style={{ width: "62mm", border: `1.5px solid ${INK}`, borderRadius: "3mm" }}
          >
            <thead>
              <tr className="text-left text-[7.5pt] font-semibold tracking-[0.06em] uppercase" style={{ color: MUTED }}>
                <th className="w-[3mm] p-0" aria-label="Pace color" />
                <th className="py-[1.2mm] pl-[2mm] font-semibold">{unitWord}</th>
                <th className="py-[1.2mm] text-right font-semibold">Split</th>
                <th className="py-[1.2mm] pr-[2.5mm] pl-[3mm] text-right font-semibold">Time</th>
              </tr>
            </thead>
            <tbody>
              {chunk.map((row) => (
                <tr key={row.at} data-testid="band-row" data-change={row.change || undefined}>
                  <td
                    className="p-0"
                    style={{ background: tones[row.tone], borderTop: `1px solid ${RULE}`, printColorAdjust: "exact" }}
                  />
                  <td
                    className="py-[0.9mm] pl-[2mm] font-semibold whitespace-nowrap"
                    style={{ borderTop: row.change ? `1.5px solid ${INK}` : `1px solid ${RULE}` }}
                  >
                    {row.finish ? "Finish" : row.at}
                  </td>
                  <td
                    className="py-[0.9mm] text-right"
                    style={{ color: MUTED, borderTop: row.change ? `1.5px solid ${INK}` : `1px solid ${RULE}` }}
                  >
                    {formatDuration(row.splitS)}
                  </td>
                  <td
                    className="py-[0.9mm] pr-[2.5mm] pl-[3mm] text-right text-[11pt] font-bold whitespace-nowrap"
                    style={{ borderTop: row.change ? `1.5px solid ${INK}` : `1px solid ${RULE}` }}
                    data-testid="band-elapsed"
                  >
                    {formatDuration(row.elapsedS)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

        <section className="min-w-[70mm] flex-1 text-[9.5pt]">
          <h2 className="text-[9pt] font-semibold tracking-[0.12em] uppercase" style={{ color: MUTED }}>
            Segments
          </h2>
          <ol className="mt-1.5">
            {plan.segments.map((s, i) => (
              <li
                key={i}
                className="pp-band-segment flex gap-[2.5mm] py-[1.4mm]"
                style={{ borderTop: `1px solid ${RULE}` }}
              >
                <span
                  className="mt-[0.6mm] h-[3.2mm] w-[1.6mm] shrink-0 rounded-full"
                  style={{ background: tones[segmentTone(s.paceSPerM, plan.flatPaceSPerM)], printColorAdjust: "exact" }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex justify-between gap-3 font-semibold tabular-nums">
                    <span>
                      {distance(s.startM)}&ndash;{distance(s.endM)} {units}
                    </span>
                    <span>
                      {formatPace(s.paceSPerM, units)} /{units} &middot; {formatDuration(times[i] ?? 0)}
                    </span>
                  </span>
                  <span className="block leading-snug" style={{ color: MUTED }}>
                    {s.reason}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[8.5pt] leading-snug" style={{ color: MUTED }}>
            Time is the clock time to reach each marker; a heavy line marks where the pace changes. Cut out a strip and
            tape it around your wrist. Made with Perfect Pace.
          </p>
        </section>
      </div>
    </div>
  );
}
