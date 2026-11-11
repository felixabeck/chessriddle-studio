/**
 * Copied snapshot from ChessRiddle frontend/web/src/lib/constants/motifs.ts and
 * frontend/shared/icon-catalog.json (2026-11-11). Server availability owns the list.
 */
export const CATEGORY_ORDER = [
    "tactics",
    "mates",
    "endgames",
    "phases",
    "position",
    "other",
] as const;
export type MotifCategory = (typeof CATEGORY_ORDER)[number];

export const CATEGORY_PATHS: Record<MotifCategory, string> = {
    tactics: "M12 2L4 7v10l8 5 8-5V7l-8-5zm0 2.5L17.5 8 12 11.5 6.5 8 12 4.5z",
    mates: "M12 2C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17h8v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm-1 14h2v2h-2v-2z",
    endgames:
        "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l4.59-4.58L18 11l-6 6z",
    phases: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z",
    position: "M3 5v14h18V5H3zm16 12H5V7h14v10zm-7-9l-4 4h3v4h2v-4h3l-4-4z",
    other: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
};

const MOTIF_METADATA: Record<string, { category: MotifCategory; icon: string }> = {
    fork: {
        category: "tactics",
        icon: "🔱",
    },
    pin: {
        category: "tactics",
        icon: "📌",
    },
    skewer: {
        category: "tactics",
        icon: "🗡️",
    },
    sacrifice: {
        category: "tactics",
        icon: "🪦",
    },
    discoveredAttack: {
        category: "tactics",
        icon: "🎭",
    },
    deflection: {
        category: "tactics",
        icon: "↪",
    },
    interference: {
        category: "tactics",
        icon: "🚧",
    },
    attraction: {
        category: "tactics",
        icon: "🧲",
    },
    hangingPiece: {
        category: "tactics",
        icon: "🎣",
    },
    quietMove: {
        category: "tactics",
        icon: "🤫",
    },
    doubleBishopMate: {
        category: "tactics",
        icon: "♗♗",
    },
    doubleCheck: {
        category: "tactics",
        icon: "++",
    },
    xRayAttack: {
        category: "tactics",
        icon: "📡",
    },
    zugzwang: {
        category: "tactics",
        icon: "⛓️",
    },
    trappedPiece: {
        category: "tactics",
        icon: "🪤",
    },
    clearance: {
        category: "tactics",
        icon: "🧹",
    },
    defensiveMove: {
        category: "tactics",
        icon: "🛡",
    },
    intermezzo: {
        category: "tactics",
        icon: "⏸️",
    },
    capturingDefender: {
        category: "tactics",
        icon: "✂️",
    },
    attackingF2F7: {
        category: "tactics",
        icon: "f7",
    },
    mate: {
        category: "mates",
        icon: "#",
    },
    mateIn1: {
        category: "mates",
        icon: "#1",
    },
    mateIn2: {
        category: "mates",
        icon: "#2",
    },
    mateIn3: {
        category: "mates",
        icon: "#3",
    },
    mateIn4: {
        category: "mates",
        icon: "#4",
    },
    mateIn5: {
        category: "mates",
        icon: "#5",
    },
    smotheredMate: {
        category: "mates",
        icon: "#♞",
    },
    backRankMate: {
        category: "mates",
        icon: "#♜",
    },
    bodenMate: {
        category: "mates",
        icon: "♗×♗",
    },
    hookMate: {
        category: "mates",
        icon: "🪝",
    },
    anastasiaMate: {
        category: "mates",
        icon: "👸",
    },
    arabianMate: {
        category: "mates",
        icon: "🐎",
    },
    dovetailMate: {
        category: "mates",
        icon: "◆♚",
    },
    killBoxMate: {
        category: "mates",
        icon: "▢♚",
    },
    vukovicMate: {
        category: "mates",
        icon: "♜♞",
    },
    bishopEndgame: {
        category: "endgames",
        icon: "♗",
    },
    knightEndgame: {
        category: "endgames",
        icon: "♘",
    },
    pawnEndgame: {
        category: "endgames",
        icon: "♙",
    },
    rookEndgame: {
        category: "endgames",
        icon: "♖",
    },
    queenEndgame: {
        category: "endgames",
        icon: "♕",
    },
    queenRookEndgame: {
        category: "endgames",
        icon: "♕♖",
    },
    opening: {
        category: "phases",
        icon: "🏁",
    },
    middlegame: {
        category: "phases",
        icon: "🌗",
    },
    endgame: {
        category: "phases",
        icon: "⏳",
    },
    kingsideAttack: {
        category: "position",
        icon: "→♚",
    },
    queensideAttack: {
        category: "position",
        icon: "♛←",
    },
    exposedKing: {
        category: "position",
        icon: "♚⚠️",
    },
    advancedPawn: {
        category: "position",
        icon: "⬆♙",
    },
    promotion: {
        category: "position",
        icon: "♙→♕",
    },
    underPromotion: {
        category: "position",
        icon: "♙→♘",
    },
    castling: {
        category: "position",
        icon: "0-0",
    },
    enPassant: {
        category: "position",
        icon: "↗♙",
    },
    short: {
        category: "other",
        icon: "🏃",
    },
    long: {
        category: "other",
        icon: "📏",
    },
    veryLong: {
        category: "other",
        icon: "🔢",
    },
    oneMove: {
        category: "other",
        icon: "1️⃣",
    },
    master: {
        category: "other",
        icon: "🎓",
    },
    masterVsMaster: {
        category: "other",
        icon: "🎓🎓",
    },
    superGM: {
        category: "other",
        icon: "★",
    },
    crushing: {
        category: "other",
        icon: "👊",
    },
    advantage: {
        category: "other",
        icon: "➕",
    },
    equality: {
        category: "other",
        icon: "⚖",
    },
};

export function motifMeta(name: string): { category: MotifCategory; icon: string } {
    return Object.hasOwn(MOTIF_METADATA, name)
        ? MOTIF_METADATA[name]
        : { category: "other", icon: "•" };
}

export const ALL_MOTIFS_ICON = "🗂️";
export const DIFFICULTY_GLYPHS = ["♙", "♘", "♗", "♖", "♕"] as const;
