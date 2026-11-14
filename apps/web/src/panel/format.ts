import { type DistanceUnit, metersToUnit } from "@pp/core";

const FEET_PER_METER = 1 / 0.3048;

const distanceFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const elevationFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export interface Quantity {
  value: string;
  unit: string;
}

/** A distance in miles or kilometers, to two decimals: `26.22 mi`. */
export function formatDistance(meters: number, units: DistanceUnit): Quantity {
  return { value: distanceFormat.format(metersToUnit(meters, units)), unit: units };
}

/** An elevation in meters, in feet with miles or meters with kilometers. */
export function elevationInUnits(meters: number, units: DistanceUnit): number {
  return units === "mi" ? meters * FEET_PER_METER : meters;
}

/** An elevation (or a climb) in feet with miles, meters with kilometers, to the whole unit. */
export function formatElevation(meters: number, units: DistanceUnit): Quantity {
  const value = elevationInUnits(meters, units);
  // `Math.round` first, so a tiny negative never prints as "-0".
  return { value: elevationFormat.format(Math.round(value) || 0), unit: units === "mi" ? "ft" : "m" };
}

export const quantityText = ({ value, unit }: Quantity): string => `${value} ${unit}`;
