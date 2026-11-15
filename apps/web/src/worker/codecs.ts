/**
 * How the core ops' large values cross `postMessage`. A course is an array of small objects, and a
 * structured clone of 50,000 of them is slow on both sides (the sender walks every object, the
 * receiver allocates every one again). Packed into typed arrays, the trip is one transferred
 * buffer, and rebuilding the objects from it is far cheaper than cloning them. Every decoded
 * value equals the original (`toEqual`), number for number.
 */
import type { Course, CoursePoint, ElevationProfile, GpxFile, LatLon, Plan } from "@pp/core";
import type { CoreOps } from "./protocol.ts";
import type { Codecs, WireCodec } from "./rpc.ts";

/** A course as typed arrays: `lat, lon, distM` per point, then each point's elevation where it has one. */
export interface PackedCourse {
  coords: Float64Array;
  ele: Float64Array;
  /** 1 where the point has an elevation. */
  hasEle: Uint8Array;
}

export function packCourse(course: Course): PackedCourse {
  const { points } = course;
  const n = points.length;
  const coords = new Float64Array(n * 3);
  const ele = new Float64Array(n);
  const hasEle = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    coords[i * 3] = p.lat;
    coords[i * 3 + 1] = p.lon;
    coords[i * 3 + 2] = p.distM;
    if (p.ele !== undefined) {
      ele[i] = p.ele;
      hasEle[i] = 1;
    }
  }
  return { coords, ele, hasEle };
}

/** The course again, its points shaped as `buildCourse` makes them (`ele` only where there is one). */
export function unpackCourse({ coords, ele, hasEle }: PackedCourse): Course {
  const n = hasEle.length;
  const points: CoursePoint[] = new Array<CoursePoint>(n);
  for (let i = 0; i < n; i++) {
    const lat = coords[i * 3]!;
    const lon = coords[i * 3 + 1]!;
    const distM = coords[i * 3 + 2]!;
    points[i] = hasEle[i] ? { lat, lon, ele: ele[i]!, distM } : { lat, lon, distM };
  }
  return { points };
}

const courseBuffers = (packed: PackedCourse): Transferable[] => [
  packed.coords.buffer,
  packed.ele.buffer,
  packed.hasEle.buffer,
];

const packNumbers = (values: readonly number[]): Float64Array => Float64Array.from(values);
const unpackNumbers = (values: Float64Array): number[] => Array.from(values);

function packLatLons(points: readonly LatLon[]): Float64Array {
  const packed = new Float64Array(points.length * 2);
  points.forEach((p, i) => {
    packed[i * 2] = p.lat;
    packed[i * 2 + 1] = p.lon;
  });
  return packed;
}

function unpackLatLons(packed: Float64Array): LatLon[] {
  const points: LatLon[] = new Array<LatLon>(packed.length / 2);
  for (let i = 0; i < points.length; i++) points[i] = { lat: packed[i * 2]!, lon: packed[i * 2 + 1]! };
  return points;
}

type WireGpx = Omit<GpxFile, "tracks"> & {
  tracks: (Omit<GpxFile["tracks"][number], "course"> & { course: PackedCourse })[];
};

const gpxFile: WireCodec<GpxFile> = {
  encode(file) {
    const tracks = file.tracks.map((track) => ({ ...track, course: packCourse(track.course) }));
    return { wire: { ...file, tracks } satisfies WireGpx, transfer: tracks.flatMap((t) => courseBuffers(t.course)) };
  },
  decode(wire) {
    const file = wire as WireGpx;
    return { ...file, tracks: file.tracks.map((track) => ({ ...track, course: unpackCourse(track.course) })) };
  },
};

type WireProfile = Omit<ElevationProfile, "course" | "rawEleM" | "grades"> & {
  course: PackedCourse;
  rawEleM: Float64Array;
  grades: Float64Array;
};

const profile: WireCodec<ElevationProfile> = {
  encode(value) {
    const wire: WireProfile = {
      ...value,
      course: packCourse(value.course),
      rawEleM: packNumbers(value.rawEleM),
      grades: packNumbers(value.grades),
    };
    return { wire, transfer: [...courseBuffers(wire.course), wire.rawEleM.buffer, wire.grades.buffer] };
  },
  decode(wire) {
    const value = wire as WireProfile;
    return {
      ...value,
      course: unpackCourse(value.course),
      rawEleM: unpackNumbers(value.rawEleM),
      grades: unpackNumbers(value.grades),
    };
  },
};

/** An input whose `course` is packed, the rest as it is. */
function withCourse<T extends { course: Course }>(): WireCodec<T> {
  return {
    encode(value) {
      const course = packCourse(value.course);
      return { wire: { ...value, course }, transfer: courseBuffers(course) };
    },
    decode(wire) {
      const value = wire as Omit<T, "course"> & { course: PackedCourse };
      return { ...value, course: unpackCourse(value.course) } as T;
    },
  };
}

type WirePlan = Omit<Plan, "idealPacesSPerM"> & { idealPacesSPerM: Float64Array };

const plan: WireCodec<Plan> = {
  encode(value) {
    const wire: WirePlan = { ...value, idealPacesSPerM: packNumbers(value.idealPacesSPerM) };
    return { wire, transfer: [wire.idealPacesSPerM.buffer] };
  },
  decode(wire) {
    const value = wire as WirePlan;
    return { ...value, idealPacesSPerM: unpackNumbers(value.idealPacesSPerM) };
  },
};

type ShareInput = CoreOps["shareTrack"]["input"];

const shareInput: WireCodec<ShareInput> = {
  encode({ points, maxChars }) {
    const packed = packLatLons(points);
    return { wire: { points: packed, maxChars }, transfer: [packed.buffer] };
  },
  decode(wire) {
    const { points, maxChars } = wire as { points: Float64Array; maxChars: number };
    return { points: unpackLatLons(points), maxChars };
  },
};

/** The codecs the app and the core worker share. */
export const CORE_CODECS: Codecs<CoreOps> = {
  parse: { output: gpxFile },
  elevation: { input: withCourse<CoreOps["elevation"]["input"]>(), output: profile },
  plan: { input: withCourse<CoreOps["plan"]["input"]>(), output: plan },
  shareTrack: { input: shareInput },
};
