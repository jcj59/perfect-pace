import type { ReactNode } from "react";
import { BUTTON_BASE, BUTTON_VARIANTS } from "../panel/FileButton.tsx";
import { drawing } from "../state/draw.ts";
import { DRAW, Icon } from "./icons.tsx";

/** A secondary panel button's classes, for drawing actions that are not `DrawButton`. */
export const SECONDARY_BUTTON = `${BUTTON_BASE} ${BUTTON_VARIANTS.secondary}`;

export interface DrawButtonProps {
  children: ReactNode;
  variant?: keyof typeof BUTTON_VARIANTS;
  className?: string;
  "aria-label"?: string;
}

/** Starts drawing a new route on the map (replacing any course), beside the panel's Load GPX. */
export function DrawButton({ children, variant = "primary", className = "", ...rest }: DrawButtonProps) {
  return (
    <button
      type="button"
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`}
      onClick={drawing.start}
      data-testid="draw-route"
      {...rest}
    >
      <Icon className={variant === "primary" ? "size-[18px]" : "size-4"}>{DRAW}</Icon>
      {children}
    </button>
  );
}
