import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://perfect-pace.test";

function get(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

describe("/api/health", () => {
  it("reports ok with the deployed version id", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<{ status: string; version: unknown }>();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });

  it("answers HEAD", async () => {
    expect((await get("/api/health", { method: "HEAD" })).status).toBe(200);
  });

  it("rejects other methods", async () => {
    const res = await get("/api/health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("routing", () => {
  it("returns a JSON 404 for unknown API paths", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("serves the web app from static assets", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Perfect Pace</title>");
  });

  it("falls back to the app shell for client routes", async () => {
    const res = await get("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });
});
