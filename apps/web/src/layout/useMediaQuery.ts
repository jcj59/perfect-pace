import { useCallback, useSyncExternalStore } from "react";

/** Whether a media query matches, kept current as the window changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}

/** Desktop layout (side panel) from this width up; below it, phones get the bottom sheet. */
export const DESKTOP_QUERY = "(min-width: 768px)";
