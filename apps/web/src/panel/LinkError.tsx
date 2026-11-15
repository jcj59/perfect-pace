import { setLinkError } from "../state/app.ts";

/** Why the share link the page was opened with could not be used, with a way to dismiss it. */
export function LinkError({ message }: { message: string }) {
  return (
    <section
      role="alert"
      aria-labelledby="link-error-title"
      data-testid="link-error"
      className="rounded-2xl border border-danger/25 bg-danger-soft p-5"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-danger text-danger-soft">
          <svg
            viewBox="0 0 24 24"
            className="size-[18px]"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 7v6M12 17h.01" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="link-error-title" className="text-[15px] leading-snug font-semibold text-ink">
            Couldn't open this link
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-pretty text-ink" data-testid="link-error-message">
            {message}
          </p>
          <button
            type="button"
            onClick={() => setLinkError(null)}
            className="mt-3 inline-flex h-9 cursor-pointer items-center rounded-lg bg-surface px-3 text-[13px] font-medium text-ink ring-1 ring-line ring-inset hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
}
