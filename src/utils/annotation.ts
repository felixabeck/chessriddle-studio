import type { AnnotationHue } from "@/styles/theme";

const pieceChars = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘" };

export function addPieceSymbol(move: string): string {
    const pieceChar = pieceChars[move[0] as keyof typeof pieceChars];

    if (typeof pieceChar === "undefined") return move;
    return pieceChar + move.slice(1);
}

export type Annotation =
    | ""
    | "!"
    | "!!"
    | "?"
    | "??"
    | "!?"
    | "?!"
    | "+-"
    | "±"
    | "⩲"
    | "="
    | "∞"
    | "⩱"
    | "∓"
    | "-+"
    | "N"
    | "↑↑"
    | "↑"
    | "→"
    | "⇆"
    | "=∞"
    | "⊕"
    | "∆"
    | "□"
    | "⨀"
    | "⊗";

export const NAG_INFO = new Map<number, Annotation>([
    [1, "!"],
    [2, "?"],
    [3, "!!"],
    [4, "??"],
    [5, "!?"],
    [6, "?!"],
    [7, "□"],
    [8, "□"],
    [9, "⊗"],
    [10, "="],
    [11, "="],
    [13, "∞"],
    [14, "⩲"],
    [15, "⩱"],
    [16, "±"],
    [17, "∓"],
    [18, "+-"],
    [19, "-+"],
    [22, "⨀"],
    [23, "⨀"],
    [32, "↑↑"],
    [33, "↑↑"],
    [36, "↑"],
    [37, "↑"],
    [40, "→"],
    [41, "→"],
    [44, "=∞"],
    [45, "=∞"],
    [132, "⇆"],
    [133, "⇆"],
    [138, "⊕"],
    [139, "⊕"],
    [140, "∆"],
    [146, "N"],
]);

export const MAX_NAG = 255;

export function isNagCode(value: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= MAX_NAG;
}

export function sortedNags(nags: readonly number[]): number[] {
    return [...nags].sort((a, b) => a - b);
}

export function nagGlyph(code: number): Annotation | undefined {
    return NAG_INFO.get(code);
}

export function nagGlyphs(nags: readonly number[]): Annotation[] {
    const glyphs = sortedNags(nags).flatMap((code) => {
        const glyph = nagGlyph(code);
        return glyph ? [glyph] : [];
    });
    return [...new Set(glyphs)];
}

// A space so two glyphs cannot spell another NAG (`!` + `?` is `!?`, `=` + `∞` is `=∞`).
export const NAG_GLYPH_SEPARATOR = " ";

export function formatNagGlyphs(glyphs: readonly Annotation[]): string {
    return glyphs.join(NAG_GLYPH_SEPARATOR);
}

/**
 * The text colour of a mark's hue, readable in both schemes (`--cf-annotation-<hue>-text` in
 * `src/styles/theme.ts`); `undefined` for gray or a mark without a hue, which keeps the
 * surrounding text colour.
 */
export function annotationTextColor(color: AnnotationHue | "gray" | undefined): string | undefined {
    return color === undefined || color === "gray"
        ? undefined
        : `var(--cf-annotation-${color}-text)`;
}

type AnnotationInfo = {
    group?: string;
    name: string;
    translationKey?: string;
    color?: AnnotationHue | "gray";
    nag: number;
};

export const ANNOTATION_INFO: Record<Annotation, AnnotationInfo> = {
    "": { name: "None", color: "gray", nag: 0 },
    "!!": {
        group: "basic",
        name: "Brilliant",
        translationKey: "Brilliant",
        color: "cyan",
        nag: 3,
    },
    "!": {
        group: "basic",
        name: "Good",
        translationKey: "Good",
        color: "teal",
        nag: 1,
    },
    "!?": {
        group: "basic",
        name: "Interesting",
        translationKey: "Interesting",
        color: "lime",
        nag: 5,
    },
    "?!": {
        group: "basic",
        name: "Dubious",
        translationKey: "Dubious",
        color: "yellow",
        nag: 6,
    },
    "?": {
        group: "basic",
        name: "Mistake",
        translationKey: "Mistake",
        color: "orange",
        nag: 2,
    },
    "??": {
        group: "basic",
        name: "Blunder",
        translationKey: "Blunder",
        color: "red",
        nag: 4,
    },
    "+-": {
        group: "advantage",
        name: "White is winning",
        translationKey: "WhiteWinning",
        nag: 18,
    },
    "±": {
        group: "advantage",
        name: "White has a clear advantage",
        translationKey: "WhiteAdvantage",
        nag: 16,
    },
    "⩲": {
        group: "advantage",
        name: "White has a slight advantage",
        translationKey: "WhiteEdge",
        nag: 14,
    },
    "=": {
        group: "advantage",
        name: "Equal position",
        translationKey: "Equal",
        nag: 10,
    },
    "∞": {
        group: "advantage",
        name: "Unclear position",
        translationKey: "Unclear",
        nag: 13,
    },
    "⩱": {
        group: "advantage",
        name: "Black has a slight advantage",
        translationKey: "BlackEdge",
        nag: 15,
    },
    "∓": {
        group: "advantage",
        name: "Black has a clear advantage",
        translationKey: "BlackAdvantage",
        nag: 17,
    },
    "-+": {
        group: "advantage",
        name: "Black is winning",
        translationKey: "BlackWinning",
        nag: 19,
    },
    N: { name: "Novelty", translationKey: "Novelty", nag: 146 },
    "↑↑": { name: "Development", translationKey: "Development", nag: 32 },
    "↑": { name: "Initiative", translationKey: "Initiative", nag: 36 },
    "→": { name: "Attack", translationKey: "Attack", nag: 40 },
    "⇆": { name: "Counterplay", translationKey: "Counterplay", nag: 132 },
    "=∞": {
        name: "With compensation",
        translationKey: "WithCompensation",
        nag: 44,
    },
    "⊕": { name: "Time Trouble", translationKey: "TimeTrouble", nag: 138 },
    "∆": { name: "With the idea", translationKey: "WithIdea", nag: 140 },
    "□": { name: "Only move", translationKey: "OnlyMove", nag: 7 },
    "⨀": { name: "Zugzwang", translationKey: "Zugzwang", nag: 22 },
    "⊗": { name: "Miss", translationKey: "Miss", color: "red", nag: 9 },
};

/** The six move-quality marks a game report derives and counts. */
export type BasicAnnotation = "!" | "!!" | "?" | "??" | "!?" | "?!";

export function isBasicAnnotation(annotation: string): annotation is BasicAnnotation {
    return ["!", "!!", "?", "??", "!?", "?!"].includes(annotation);
}
