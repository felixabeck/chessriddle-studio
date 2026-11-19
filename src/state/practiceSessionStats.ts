export type PracticeSessionStats = {
    mode: "anki" | "full";
    remainingPositionKeys: string[];
    reappendedPositionKeys: string[];
    introducedPositionKeys: string[];
    correct: number;
    incorrect: number;
    streak: number;
    bestStreak: number;
};

/** The one starting value for a tab's practice stats: first mount and every reset use it. */
export function emptyPracticeStats(): PracticeSessionStats {
    return {
        mode: "anki",
        remainingPositionKeys: [],
        reappendedPositionKeys: [],
        introducedPositionKeys: [],
        correct: 0,
        incorrect: 0,
        streak: 0,
        bestStreak: 0,
    };
}
