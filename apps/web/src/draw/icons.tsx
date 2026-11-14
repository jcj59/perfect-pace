import type { ReactNode } from "react";

/** A 24 px line icon in the panel's style: round caps, the current text color. */
export function Icon({ children, className = "size-[18px]" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const UNDO = <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />;
export const REDO = <path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />;
export const CLEAR = <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />;
/** A leg that follows paths: a winding line between two points. */
export const PATHS = (
  <>
    <path d="M6.5 17.5c3.5 0 2-6 5.5-6s2-6 5.5-6" />
    <circle cx="5" cy="18.5" r="1.8" fill="currentColor" stroke="none" />
    <circle cx="19" cy="5.5" r="1.8" fill="currentColor" stroke="none" />
  </>
);
/** A straight leg: a straight line between two points. */
export const STRAIGHT = (
  <>
    <path d="M6.5 17.5 17.5 6.5" />
    <circle cx="5" cy="19" r="1.8" fill="currentColor" stroke="none" />
    <circle cx="19" cy="5" r="1.8" fill="currentColor" stroke="none" />
  </>
);
export const LOOP = <path d="M20 12a8 8 0 1 1-2.35-5.65M20 4v4.5h-4.5" />;
export const OUT_AND_BACK = <path d="M4 8.5h14l-3.5-3.5M20 15.5H6l3.5 3.5" />;
/** Drawing a route: a path through points. */
export const DRAW = (
  <>
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="6" r="2.2" />
    <path d="M8.2 18H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5.8" />
  </>
);
export const CHECK = <path d="m5 12.5 4.5 4.5L19 7.5" />;
export const RETRY = (
  <path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.66 5.66L4 15.5M4 20v-4.5h4.5" />
);
