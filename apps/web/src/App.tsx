import { useEffect, useState } from "react";

type Status = "checking" | "online" | "offline";

/** Placeholder page until the app shell lands (PR 6). It proves the Worker serves the page and the API. */
export function App() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    performance.mark("pp:ready");
    let cancelled = false;
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(() => !cancelled && setStatus("online"))
      .catch(() => !cancelled && setStatus("offline"));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex min-h-full items-center justify-center bg-stone-50 px-4 py-12 font-sans text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <div className="w-full max-w-md text-center">
        <svg
          viewBox="0 0 120 40"
          className="mx-auto h-12 w-36 text-accent"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 32 L22 30 L38 14 L52 20 L68 8 L84 22 L100 18 L116 30" />
        </svg>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight">Perfect Pace</h1>
        <p className="mt-3 text-lg text-stone-600 dark:text-stone-400">Elevation-aware pacing plans for any course.</p>
        <p className="mt-8 inline-flex items-center gap-2 rounded-full border border-stone-200 px-4 py-1.5 text-sm text-stone-600 dark:border-stone-800 dark:text-stone-400">
          <span
            className={
              status === "online"
                ? "size-2 rounded-full bg-accent"
                : status === "offline"
                  ? "size-2 rounded-full bg-red-500"
                  : "size-2 rounded-full bg-stone-400"
            }
            aria-hidden="true"
          />
          <span data-testid="status">
            {status === "online" ? "Coming soon" : status === "offline" ? "Service unavailable" : "Checking service"}
          </span>
        </p>
      </div>
    </main>
  );
}
