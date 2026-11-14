import { FileButton } from "./FileButton.tsx";

export interface LoadErrorProps {
  fileName: string;
  message: string;
}

/** Why a file did not load, in the parser's own words, and the way to try another. */
export function LoadError({ fileName, message }: LoadErrorProps) {
  return (
    <section
      role="alert"
      aria-labelledby="load-error-title"
      data-testid="load-error"
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
        <div className="min-w-0">
          <h2 id="load-error-title" className="text-[15px] leading-snug font-semibold text-ink">
            Couldn't load <span className="break-all">{fileName}</span>
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-pretty text-ink" data-testid="load-error-message">
            {message}
          </p>
        </div>
      </div>
      <FileButton variant="secondary" className="mt-4 ml-11">
        Choose another file
      </FileButton>
    </section>
  );
}
