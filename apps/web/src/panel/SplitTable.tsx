import { type DistanceUnit, type Plan, formatDuration, formatPace, metersToUnit } from "@pp/core";
import { paceBand, splitPace } from "../plan/export.ts";
import { toneLabel, toneVar } from "../plan/tones.ts";

/**
 * The Splits view of any plan: one row per mile or kilometer (the last one to the finish) with
 * its average pace, its split time and the time elapsed at its end, which is what a pace band
 * holds. The splits add up to the elapsed times, and the last elapsed time is the plan's finish.
 * A heavier rule marks a split where the pace changes.
 */
export function SplitTable({ plan, units }: { plan: Plan; units: DistanceUnit }) {
  const rows = paceBand(plan, units);
  const unitWord = units === "mi" ? "Mile" : "Km";
  const finish = rows.at(-1);
  const body = rows.slice(0, -1);
  const total = finish?.elapsedS ?? 0;
  const lengthU = metersToUnit(plan.lengthM, units);

  return (
    <table
      className="w-full table-fixed border-separate border-spacing-0 text-sm tabular-nums"
      data-testid="split-table"
    >
      <caption className="sr-only">
        Pace, split time and elapsed time for every {units === "mi" ? "mile" : "kilometer"} of the course.
      </caption>
      <colgroup>
        <col />
        <col className="w-[64px]" />
        <col className="w-[72px]" />
        <col className="w-[80px]" />
      </colgroup>
      <thead>
        <tr className="text-left text-[11px] font-semibold tracking-[0.04em] whitespace-nowrap text-ink-subtle uppercase">
          <th scope="col" className="pb-2 pl-3 font-semibold">
            {unitWord}
          </th>
          <th scope="col" className="pb-2 text-right font-semibold">
            Pace /{units}
          </th>
          <th scope="col" className="pb-2 text-right font-semibold">
            Split
          </th>
          <th scope="col" className="pr-3 pb-2 text-right font-semibold">
            Elapsed
          </th>
        </tr>
      </thead>
      <tbody>
        {body.map((row) => {
          const rule = row.change ? "border-t-2 border-ink-subtle/40" : "border-t border-line";
          const cell = `${rule} py-2 align-baseline`;
          return (
            <tr
              key={row.at}
              data-testid="split-row"
              data-tone={row.tone}
              data-change={row.change || undefined}
              className="transition-colors hover:bg-surface-raised"
            >
              <th scope="row" className={`${cell} pl-3 text-left font-semibold text-ink`}>
                <span className="flex items-center gap-2">
                  <span
                    className="h-3.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: toneVar(row.tone) }}
                    aria-hidden="true"
                  />
                  {row.at}
                  <span className="sr-only">, {toneLabel(row.tone)}</span>
                </span>
              </th>
              <td className={`${cell} text-right font-semibold text-ink`} data-testid="split-pace">
                {formatPace(splitPace(row), units)}
              </td>
              <td className={`${cell} text-right text-ink-muted`} data-testid="split-time">
                {formatDuration(row.splitS)}
              </td>
              <td className={`${cell} pr-3 text-right text-ink`} data-testid="split-elapsed">
                {formatDuration(row.elapsedS)}
              </td>
            </tr>
          );
        })}
      </tbody>
      {finish && (
        <tfoot>
          <tr className="font-semibold text-ink" data-testid="split-finish" data-tone={finish.tone}>
            <th scope="row" className="border-t-2 border-line pt-2.5 pl-3 text-left">
              <span className="flex items-center gap-2">
                <span
                  className="h-3.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: toneVar(finish.tone) }}
                  aria-hidden="true"
                />
                Finish
                <span className="text-xs font-normal text-ink-muted">{lengthU.toFixed(2)}</span>
              </span>
            </th>
            <td className="border-t-2 border-line pt-2.5 text-right" data-testid="split-pace">
              {formatPace(splitPace(finish), units)}
            </td>
            <td className="border-t-2 border-line pt-2.5 text-right text-ink-muted" data-testid="split-time">
              {formatDuration(finish.splitS)}
            </td>
            <td className="border-t-2 border-line pt-2.5 pr-3 text-right" data-testid="plan-total">
              {formatDuration(total)}
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
