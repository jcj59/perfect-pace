function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
      }
      return json({ status: "ok", version: env.CF_VERSION_METADATA.id });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not_found" }, 404);
    }

    // Only /api/* runs the Worker first; this covers any other request routed here.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
