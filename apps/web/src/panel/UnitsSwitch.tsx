import type { DistanceUnit } from "@pp/core";
import { setUnits, useAppState } from "../state/app.ts";

const OPTIONS: { value: DistanceUnit; short: string; label: string }[] = [
  { value: "mi", short: "mi", label: "Miles and feet" },
  { value: "km", short: "km", label: "Kilometers and meters" },
];

/** Miles (with feet) or kilometers (with meters), for every number in the panel. */
export function UnitsSwitch() {
  const units = useAppState((s) => s.units);
  return (
    <fieldset className="flex items-center">
      <legend className="sr-only">Units</legend>
      <div className="flex rounded-full bg-surface-raised p-0.5 ring-1 ring-line ring-inset">
        {OPTIONS.map(({ value, short, label }) => (
          <label
            key={value}
            className="relative cursor-pointer rounded-full px-3 py-1 text-[13px] font-semibold text-ink-muted transition-colors select-none hover:text-ink has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-accent"
          >
            <input
              type="radio"
              name="units"
              value={value}
              aria-label={label}
              checked={units === value}
              onChange={() => setUnits(value)}
              className="sr-only"
            />
            {short}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
