import type { ReactNode } from "react";
import { BUTTON_BASE, BUTTON_VARIANTS } from "../panel/FileButton.tsx";
import { usePwaState } from "../pwa/pwa.ts";
import { drawing } from "../state/draw.ts";
import { DRAW, Icon } from "./icons.tsx";

/** A secondary panel button's classes, for drawing actions that are not `DrawButton`. */
export const SECONDARY_BUTTON = `${BUTTON_BASE} ${BUTTON_VARIANTS.secondary}`;

/** Why the drawing buttons are off while offline (their tooltip; the panel says it in words too). */
export const DRAW_OFFLINE_TITLE = "Drawing needs an internet connection";

export interface DrawButtonProps {
  children: ReactNode;
  variant?: keyof typeof BUTTON_VARIANTS;
  className?: string;
  "aria-label"?: string;
}

/**
 * Starts drawing a new route on the map (replacing any course), beside the panel's Load GPX. Off
 * while offline: legs follow paths through the routing service, and the basemap is not cached.
 */
export function DrawButton({ children, variant = "primary", className = "", ...rest }: DrawButtonProps) {
  const online = usePwaState((s) => s.online);
  return (
    <button
      type="button"
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`}
      onClick={drawing.start}
      disabled={!online}
      title={online ? undefined : DRAW_OFFLINE_TITLE}
      data-testid="draw-route"
      {...rest}
    >
      <Icon className={variant === "primary" ? "size-[18px]" : "size-4"}>{DRAW}</Icon>
      {children}
    </button>
  );
}
