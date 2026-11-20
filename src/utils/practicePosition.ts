import type { Card } from "ts-fsrs";
import { z } from "zod";

export const positionSchema = z.object({
    fen: z.string(),
    answer: z.string(),
    card: z.object({}).passthrough(),
    outOfScope: z.literal(true).optional(),
});

export type Position = {
    fen: string;
    answer: string;
    card: Card;
    /** A card whose position is still in the tree but outside the current (orientation, Start) practice scope; it keeps its schedule and is excluded from practice and stats until the scope includes it again (f-20261115-21). */
    outOfScope?: true;
};
