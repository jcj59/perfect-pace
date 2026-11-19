import { type DistanceUnit, type Plan, formatDuration, formatPace, metersToUnit } from "@pp/core";
import type { ReactNode } from "react";
import { type BandRow, type SegmentBandRow, paceBand, segmentBand } from "../plan/export.ts";
import { roundPreservingSum } from "../plan/inputs.ts";
import { TONE_COLORS, segmentTone } from "../plan/tones.ts";
import type { TableView } from "../state/app.ts";

/** Rows per strip: a strip stays short enough to wrap around a wrist and fit the page. */
const MAX_ROWS_PER_STRIP = 30;

/** Print ink: always dark on white, whatever theme the screen is in. */
const INK = "#1c1917";
const MUTED = "#57534e";
const RULE = "#d6d3ce";

/**
 * The printed pace band, shown only when printing (the app hides itself in print; see
 * `styles.css`). One or more strips that follow the table's view: in Splits, the time to reach
 * each mile or kilometer marker with each split; in Segments, each segment's pace and the time to
 * reach its end. Each row has a stripe in its segment's color (in Splits, where the pace changes
 * is marked). Then the plan's segments with their paces and reasons. Colors are the light theme's,
 * since paper is white.
 */
export function PaceBand({
  plan,
  units,
  view,
  title,
}: {
  plan: Plan;
  units: DistanceUnit;
  view: TableView;
  title: string;
}) {
  const rows: (BandRow | SegmentBandRow)[] = view === "splits" ? paceBand(plan, units) : segmentBand(plan);
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
            data-view={view}
          >
            <thead>
              <tr className="text-left text-[7.5pt] font-semibold tracking-[0.06em] uppercase" style={{ color: MUTED }}>
                <th className="w-[3mm] p-0" aria-label="Pace color" />
                <th className="py-[1.2mm] pl-[2mm] font-semibold">{view === "splits" ? unitWord : `To ${units}`}</th>
                <th className="py-[1.2mm] text-right font-semibold">{view === "splits" ? "Split" : "Pace"}</th>
                <th className="py-[1.2mm] pr-[2.5mm] pl-[3mm] text-right font-semibold">Time</th>
              </tr>
            </thead>
            <tbody>
              {chunk.map((row) =>
                "at" in row ? (
                  <StripRow
                    key={row.at}
                    color={tones[row.tone]}
                    change={row.change}
                    label={row.finish ? "Finish" : row.at}
                    middle={formatDuration(row.splitS)}
                    elapsedS={row.elapsedS}
                  />
                ) : (
                  <StripRow
                    key={row.index}
                    color={tones[row.tone]}
                    change={false}
                    label={row.index === plan.segments.length - 1 ? "Finish" : distance(row.endM)}
                    middle={formatPace(row.paceSPerM, units)}
                    elapsedS={row.elapsedS}
                  />
                ),
              )}
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
            {view === "splits"
              ? "Time is the clock time to reach each marker; a heavy line marks where the pace changes."
              : "Hold each pace to the distance beside it; time is the clock time to reach it."}{" "}
            Cut out a strip and tape it around your wrist. Made with Perfect Pace.
          </p>
        </section>
      </div>
    </div>
  );
}

/** One row of a strip: a color stripe, the marker, the split or pace, and the clock time there. */
function StripRow({
  color,
  change,
  label,
  middle,
  elapsedS,
}: {
  color: string;
  change: boolean;
  label: ReactNode;
  middle: string;
  elapsedS: number;
}) {
  const rule = change ? `1.5px solid ${INK}` : `1px solid ${RULE}`;
  return (
    <tr data-testid="band-row" data-change={change || undefined}>
      <td className="p-0" style={{ background: color, borderTop: `1px solid ${RULE}`, printColorAdjust: "exact" }} />
      <td className="py-[0.9mm] pl-[2mm] font-semibold whitespace-nowrap" style={{ borderTop: rule }}>
        {label}
      </td>
      <td className="py-[0.9mm] text-right" style={{ color: MUTED, borderTop: rule }}>
        {middle}
      </td>
      <td
        className="py-[0.9mm] pr-[2.5mm] pl-[3mm] text-right text-[11pt] font-bold whitespace-nowrap"
        style={{ borderTop: rule }}
        data-testid="band-elapsed"
      >
        {formatDuration(elapsedS)}
      </td>
    </tr>
  );
}
