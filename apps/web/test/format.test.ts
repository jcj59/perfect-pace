import { parseGpx } from "@pp/core";
import { describe, expect, it } from "vitest";
import { formatDistance, formatElevation, quantityText } from "../src/panel/format.ts";
import { trackTitle } from "../src/state/course.ts";

describe("panel number formats", () => {
  it("formats distance to two decimals in miles or kilometers", () => {
    expect(quantityText(formatDistance(42_195, "mi"))).toBe("26.22 mi");
    expect(quantityText(formatDistance(42_195, "km"))).toBe("42.20 km");
    expect(quantityText(formatDistance(0, "km"))).toBe("0.00 km");
  });

  it("formats elevation in whole feet (with miles) or meters (with kilometers)", () => {
    expect(quantityText(formatElevation(100, "mi"))).toBe("328 ft");
    expect(quantityText(formatElevation(1234.4, "km"))).toBe("1,234 m");
    expect(quantityText(formatElevation(-0.2, "km"))).toBe("0 m");
    expect(quantityText(formatElevation(-12.6, "km"))).toBe("-13 m");
  });
});

describe("trackTitle", () => {
  const pts = '<trkpt lat="42.44" lon="-76.5"/><trkpt lat="42.45" lon="-76.5"/>';
  const gpx = (body: string, meta = "") => parseGpx(`<gpx version="1.1">${meta}${body}</gpx>`);

  it("uses the track's name, then the file's, then the file name", () => {
    expect(trackTitle(gpx(`<trk><name>Race</name><trkseg>${pts}</trkseg></trk>`), 0, "a.gpx")).toBe("Race");
    expect(
      trackTitle(gpx(`<trk><trkseg>${pts}</trkseg></trk>`, "<metadata><name>Run</name></metadata>"), 0, "a.gpx"),
    ).toBe("Run");
    expect(trackTitle(gpx(`<trk><trkseg>${pts}</trkseg></trk>`), 0, "Long Run.GPX")).toBe("Long Run");
  });

  it("numbers unnamed tracks and routes separately in a multi-track file", () => {
    const file = gpx(
      `<trk><trkseg>${pts}</trkseg></trk><rte>${pts.replace(/trkpt/g, "rtept")}</rte><trk><trkseg>${pts}</trkseg></trk>`,
    );
    expect([0, 1, 2].map((i) => trackTitle(file, i, "x.gpx"))).toEqual(["Track 1", "Route 1", "Track 2"]);
  });
});
