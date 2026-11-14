export { prefixSums, rangeSum } from "./prefix-sums.ts";
export { EARTH_RADIUS_M, type LatLon, haversineM, lerpLatLon } from "./geo.ts";
export {
  type Course,
  type CoursePoint,
  type TrackPoint,
  DEFAULT_RESAMPLE_SPACING_M,
  buildCourse,
  courseLengthM,
  pointAtDistance,
  resampleCourse,
} from "./course.ts";
export {
  type DistanceUnit,
  METERS_PER_KM,
  METERS_PER_MILE,
  formatDuration,
  formatPace,
  metersPerUnit,
  metersToUnit,
  paceFromUnit,
  paceToUnit,
  parseDuration,
  unitToMeters,
} from "./units.ts";
export { type GpxErrorCode, type GpxFile, type GpxTrack, GpxError, parseGpx } from "./gpx.ts";
export { simplify } from "./simplify.ts";
export {
  DEFAULT_GAIN_THRESHOLD_M,
  DEFAULT_MEDIAN_WINDOW_M,
  DEFAULT_SMOOTHING_SIGMA_M,
  type ElevationStats,
  type GainLoss,
  MAX_ABS_GRADE,
  type SmoothingOptions,
  computeGrades,
  elevationStats,
  gainLoss,
  gaussianSmooth,
  medianFilter,
  smoothElevations,
} from "./elevation.ts";
export {
  DEFAULT_TERRARIUM_ZOOM,
  DEFAULT_TILE_CACHE_SIZE,
  type DecodedImage,
  ElevationError,
  type ElevationErrorCode,
  type ElevationProvider,
  TERRARIUM_URL_TEMPLATE,
  type TerrariumOptions,
  type TileDecoder,
  type TileFetcher,
  canvasTileDecoder,
  decodeTerrariumPixel,
  terrariumProvider,
  urlTileFetcher,
} from "./terrarium.ts";
export {
  type CourseOrigin,
  type ElevationProfile,
  type ElevationProfileOptions,
  type ElevationSource,
  FLAT_PLACEHOLDER_MIN_LENGTH_M,
  type GpsElevationAssessment,
  type GpsElevationIssue,
  MAX_PLAUSIBLE_ELE_M,
  MAX_SPIKE_SHARE,
  MIN_GPS_COVERAGE,
  MIN_PLAUSIBLE_ELE_M,
  SPIKE_M,
  assessGpsElevation,
  buildElevationProfile,
} from "./elevation-profile.ts";
export {
  DANIELS_DOWNHILL_S_PER_MI_PER_PERCENT,
  DANIELS_UPHILL_S_PER_MI_PER_PERCENT,
  type IdealPaces,
  type PaceModel,
  additivePaceModel,
  danielsAdjustment,
  danielsPaceModel,
} from "./pace-model.ts";
export { type Segmentation, type SegmentationOptions, segmentLeastSquares } from "./segmenter.ts";
export {
  CLIMB_GRADE,
  DEFAULT_CURVE_MAX_PACE_CHANGES,
  type ErrorCurvePoint,
  GENTLE_GRADE,
  type Plan,
  type PlanInputs,
  type PlanSegment,
  ROLLING_RELIEF,
  type Terrain,
  classifyTerrain,
  computePlan,
  segmentReason,
} from "./plan.ts";
