import { z } from "zod";

/** Yellow, orange and blue, the same presets as ChessRiddle's board settings. */
export const LAST_MOVE_HIGHLIGHT_PRESETS = ["#ffff00", "#ff9500", "#0095ff"] as const;
export const LAST_MOVE_HIGHLIGHT_COLOR_DEFAULT = LAST_MOVE_HIGHLIGHT_PRESETS[0];

export const LAST_MOVE_HIGHLIGHT_OPACITY_DEFAULT = 40;
export const LAST_MOVE_HIGHLIGHT_OPACITY_MIN = 10;
export const LAST_MOVE_HIGHLIGHT_OPACITY_MAX = 100;
export const LAST_MOVE_HIGHLIGHT_OPACITY_STEP = 5;

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** A `#rrggbb` colour; upper-case digits are stored lower-case. */
export const lastMoveHighlightColorSchema = z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.string().regex(HEX_COLOR));

export const lastMoveHighlightOpacitySchema = z
    .number()
    .int()
    .min(LAST_MOVE_HIGHLIGHT_OPACITY_MIN)
    .max(LAST_MOVE_HIGHLIGHT_OPACITY_MAX)
    .multipleOf(LAST_MOVE_HIGHLIGHT_OPACITY_STEP);

/** Returns the lower-case colour when `value` is a complete `#rrggbb` colour, otherwise null. */
export function parseLastMoveHighlightColor(value: string): string | null {
    const parsed = lastMoveHighlightColorSchema.safeParse(value.trim());
    return parsed.success ? parsed.data : null;
}

/** The CSS colour painted on the last move's squares. */
export function lastMoveHighlightBackground(color: string, opacityPercent: number): string {
    const red = Number.parseInt(color.slice(1, 3), 16);
    const green = Number.parseInt(color.slice(3, 5), 16);
    const blue = Number.parseInt(color.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${opacityPercent / 100})`;
}
