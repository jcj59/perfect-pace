/**
 * A minimal basemap over OpenFreeMap's OpenMapTiles vector tiles: land, water, parks, roads and
 * paths, and a few place labels. It stays quiet so the course and its segment colors (later
 * units) carry the map. One style per theme, built from a small palette.
 */
import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";
import type { Theme } from "../state/app.ts";

/** OpenFreeMap TileJSON (free, no key). Its tile URLs are versioned, so always go through it. */
export const OPENFREEMAP_TILEJSON = "https://tiles.openfreemap.org/planet";
export const OPENFREEMAP_GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
export const MAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

interface Palette {
  land: string;
  park: string;
  wood: string;
  water: string;
  waterLine: string;
  building: string;
  boundary: string;
  roadMajor: string;
  roadMinor: string;
  roadCasing: string;
  path: string;
  label: string;
  labelHalo: string;
  waterLabel: string;
}

// Warm stone neutrals to match the panel. Water and greens are desaturated on purpose.
const PALETTES: Record<Theme, Palette> = {
  light: {
    land: "#f3f1ec",
    park: "#e2e9d8",
    wood: "#d9e3cf",
    water: "#c9d9e3",
    waterLine: "#b5c9d6",
    building: "#e6e2da",
    boundary: "#b8b1a6",
    roadMajor: "#ffffff",
    roadMinor: "#ffffff",
    roadCasing: "#dfd9cf",
    path: "#c9c1b4",
    label: "#57534e",
    labelHalo: "#f3f1ec",
    waterLabel: "#6f8a9c",
  },
  dark: {
    land: "#1a1918",
    park: "#1f241d",
    wood: "#212720",
    water: "#18232b",
    waterLine: "#22313b",
    building: "#232120",
    boundary: "#4d4842",
    roadMajor: "#3a3734",
    roadMinor: "#2e2c2a",
    roadCasing: "#141312",
    path: "#45413c",
    label: "#a8a29e",
    labelHalo: "#1a1918",
    waterLabel: "#5d7686",
  },
};

const FONT_REGULAR = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];
const NAME: ExpressionSpecification = ["coalesce", ["get", "name:en"], ["get", "name"]];

/** Line width that doubles per zoom level between `z0` (width `w0`) and `z1` (width `w1`). */
function width(z0: number, w0: number, z1: number, w1: number): ExpressionSpecification {
  return ["interpolate", ["exponential", 1.6], ["zoom"], z0, w0, z1, w1];
}

const MAJOR: ExpressionSpecification = ["match", ["get", "class"], ["motorway", "trunk", "primary"], true, false];
const MID: ExpressionSpecification = ["match", ["get", "class"], ["secondary", "tertiary"], true, false];
const MINOR: ExpressionSpecification = ["match", ["get", "class"], ["minor", "service"], true, false];
const PATH: ExpressionSpecification = ["match", ["get", "class"], ["path", "track"], true, false];

export function mapStyle(theme: Theme): StyleSpecification {
  const c = PALETTES[theme];
  return {
    version: 8,
    name: `Perfect Pace ${theme}`,
    glyphs: OPENFREEMAP_GLYPHS,
    sources: {
      openmaptiles: { type: "vector", url: OPENFREEMAP_TILEJSON, attribution: MAP_ATTRIBUTION },
    },
    layers: [
      { id: "land", type: "background", paint: { "background-color": c.land } },
      {
        id: "park",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "park",
        paint: { "fill-color": c.park },
      },
      {
        id: "wood",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landcover",
        filter: ["match", ["get", "class"], ["wood", "grass"], true, false],
        paint: { "fill-color": c.wood, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 12, 1] },
      },
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: { "fill-color": c.water },
      },
      {
        id: "waterway",
        type: "line",
        source: "openmaptiles",
        "source-layer": "waterway",
        minzoom: 8,
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: { "line-color": c.waterLine, "line-width": width(8, 0.5, 16, 3) },
      },
      {
        id: "building",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 14,
        paint: { "fill-color": c.building, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 1] },
      },
      {
        id: "boundary",
        type: "line",
        source: "openmaptiles",
        "source-layer": "boundary",
        filter: ["all", ["<=", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        paint: {
          "line-color": c.boundary,
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 8, 1.2],
          "line-dasharray": [3, 2],
        },
      },
      {
        id: "path",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 13,
        filter: PATH,
        layout: { "line-cap": "round" },
        paint: { "line-color": c.path, "line-width": width(13, 0.6, 18, 2), "line-dasharray": [2, 1.5] },
      },
      {
        id: "road-minor-casing",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 12,
        filter: MINOR,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.roadCasing, "line-width": width(12, 1, 18, 16) },
      },
      {
        id: "road-casing",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 7,
        filter: ["any", MAJOR, MID],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.roadCasing, "line-width": width(7, 1, 18, 26) },
      },
      {
        id: "road-minor",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 12,
        filter: MINOR,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.roadMinor, "line-width": width(12, 0.5, 18, 13) },
      },
      {
        id: "road",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 5,
        filter: ["any", MAJOR, MID],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": c.roadMajor,
          "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 5, ["case", MAJOR, 0.6, 0.3], 18, 22],
        },
      },
      {
        id: "water-label",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "water_name",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": NAME,
          "text-font": FONT_REGULAR,
          "text-size": 12,
          "text-letter-spacing": 0.08,
          "text-max-width": 8,
        },
        paint: { "text-color": c.waterLabel, "text-halo-color": c.water, "text-halo-width": 1 },
      },
      {
        id: "road-label",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "transportation_name",
        minzoom: 14,
        layout: {
          "symbol-placement": "line",
          "text-field": NAME,
          "text-font": FONT_REGULAR,
          "text-size": 11,
        },
        paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.5 },
      },
      {
        id: "place-minor",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        minzoom: 10,
        filter: ["match", ["get", "class"], ["village", "suburb", "neighbourhood", "hamlet"], true, false],
        layout: { "text-field": NAME, "text-font": FONT_REGULAR, "text-size": 12, "text-max-width": 8 },
        paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.5 },
      },
      {
        id: "place-city",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        minzoom: 4,
        filter: ["match", ["get", "class"], ["city", "town"], true, false],
        layout: {
          "text-field": NAME,
          "text-font": ["case", ["==", ["get", "class"], "city"], ["literal", FONT_BOLD], ["literal", FONT_REGULAR]],
          "text-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4,
            ["case", ["==", ["get", "class"], "city"], 12, 10],
            12,
            16,
          ],
          "text-max-width": 8,
          "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.5 },
      },
      {
        id: "place-region",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        maxzoom: 7,
        filter: ["match", ["get", "class"], ["country", "state"], true, false],
        layout: {
          "text-field": NAME,
          "text-font": FONT_REGULAR,
          "text-size": ["case", ["==", ["get", "class"], "country"], 13, 11],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.12,
          "text-max-width": 7,
        },
        paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.5, "text-opacity": 0.8 },
      },
    ],
  };
}
