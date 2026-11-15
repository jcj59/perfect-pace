import { useId } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** A longer name for assistive technology, when the label is short. */
  ariaLabel?: string;
}

/**
 * A segmented control: one choice of a few, as radio buttons (so the arrow keys move between
 * them and the group is one tab stop). `fill` stretches it across its row with equal options;
 * otherwise it is as wide as its labels.
 */
export function Segmented<T extends string>({
  legend,
  showLegend = false,
  options,
  value,
  onChange,
  fill = false,
  testId,
}: {
  legend: string;
  /** Show the legend before the control, on its row. Otherwise it is for assistive technology only. */
  showLegend?: boolean;
  options: readonly SegmentedOption<T>[];
  /** The checked option, or null for none. */
  value: T | null;
  onChange: (value: T) => void;
  fill?: boolean;
  testId?: string;
}) {
  const name = useId();
  return (
    <fieldset
      className={showLegend ? "flex items-center justify-between gap-3" : "block"}
      data-testid={testId}
      data-value={value ?? undefined}
    >
      <legend className={showLegend ? "float-left text-sm font-medium text-ink" : "sr-only"}>{legend}</legend>
      <div
        className={`${fill ? "grid w-full" : "flex"} rounded-xl bg-surface-raised p-1 ring-1 ring-line ring-inset`}
        style={fill ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
      >
        {options.map((o) => (
          <label
            key={o.value}
            className="relative flex h-8 cursor-pointer items-center justify-center rounded-lg px-3 text-[13px] font-semibold whitespace-nowrap text-ink-muted transition-colors select-none hover:text-ink has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-accent"
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              {...(o.ariaLabel ? { "aria-label": o.ariaLabel } : {})}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
