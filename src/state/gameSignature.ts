import type { GameSignature, NormalizedGame } from "@/bindings";

/** Match the native index's absent header markers without decoding PGN escapes. */
export function normalizeGameSignature(signature: GameSignature): GameSignature {
    const absent = (value: string | null, kind: "name" | "date" | "round" = "name") =>
        value == null ||
        value === "" ||
        value === "?" ||
        (kind === "date" && value === "????.??.??") ||
        (kind === "name" && value === "Unknown")
            ? null
            : value;
    return {
        white: absent(signature.white),
        black: absent(signature.black),
        event: absent(signature.event),
        site: absent(signature.site),
        date: absent(signature.date, "date"),
        round: absent(signature.round, "round"),
    };
}

export function gameSignature(game: NormalizedGame): GameSignature {
    return {
        white: game.white,
        black: game.black,
        event: game.event,
        site: game.site,
        date: game.date ?? null,
        round: game.round ?? null,
    };
}
