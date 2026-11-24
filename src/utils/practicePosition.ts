import type { Card } from "ts-fsrs";
import { z } from "zod";

/** A finite probability in (0, 1]. Anything else is unknown. */
export function validWeight(weight: unknown): number | undefined {
    return typeof weight === "number" && Number.isFinite(weight) && weight > 0 && weight <= 1
        ? weight
        : undefined;
}

export const positionSchema = z.object({
    fen: z.string(),
    answer: z.string(),
    card: z.object({}).passthrough(),
    outOfScope: z.literal(true).optional(),
    weight: z
        .number()
        .refine((value) => validWeight(value) !== undefined)
        .optional()
        .catch(undefined),
});

export type Position = {
    fen: string;
    answer: string;
    card: Card;
    /** A card whose position is still in the tree but outside the current (orientation, Start) practice scope; it keeps its schedule and is excluded from practice and stats until the scope includes it again (f-20261115-21). */
    outOfScope?: true;
    /** Probability this position occurs, from the reference database. Absent means unknown. */
    weight?: number;
};
