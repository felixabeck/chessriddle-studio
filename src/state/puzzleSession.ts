import { z } from "zod";
import i18n from "@/i18n";
import enUSCatalogue from "@/translation/en-US.json";
import { getPuzzleProgress, validateMoveSequence } from "@/utils/puzzles";
import {
    getBoardState,
    getNodeAtPath,
    getResolvedPathLength,
    type TreeState,
} from "@/utils/treeReducer";
import { positionFromFen } from "@/utils/chessops";
import { pathRefSchema } from "@/utils/pathCapabilities";
import { decodeCompressedOrJson, serializeStorageValue } from "./store/debouncedStorage";
import { persistStorageWriteError } from "./storageWriteError";
import { reportPersistError } from "./persistError";

export const MAX_PUZZLE_ATTEMPTS = 100;
export const MAX_PUZZLE_SESSION_BYTES = 32_768;
const MAX_PUZZLE_FEN_LENGTH = 256;
const MAX_PUZZLE_MOVES = 512;
const MAX_PUZZLE_THEMES = 128;
const MAX_PUZZLE_THEME_LENGTH = 256;
const MAX_PUZZLE_ATTEMPT_ID_LENGTH = 128;
export const LEGACY_PUZZLE_SUFFIX = "-puzzles";

/** Shared by native row admission, legacy migration and the persisted session. */
export const puzzleSchema = z
    .object({
        id: z.number().int().nonnegative().safe(),
        fen: z.string().min(1).max(MAX_PUZZLE_FEN_LENGTH),
        moves: z
            .array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/))
            .min(1)
            .max(MAX_PUZZLE_MOVES),
        rating: z.number().finite(),
        rating_deviation: z.number().finite(),
        popularity: z.number().finite(),
        nb_plays: z.number().int().nonnegative().safe(),
        completion: z.enum(["correct", "incorrect", "incomplete"]),
        timeSpent: z.number().finite().nonnegative().optional(),
        themes: z.array(z.string().max(MAX_PUZZLE_THEME_LENGTH)).max(MAX_PUZZLE_THEMES).optional(),
    })
    .superRefine((puzzle, context) => {
        if (!validateMoveSequence(puzzle.fen, puzzle.moves).success) {
            context.addIssue({ code: "custom", message: "Invalid puzzle move sequence" });
        }
    });

export type Puzzle = z.infer<typeof puzzleSchema>;
export type Completion = Puzzle["completion"];
const attemptIdSchema = z.string().min(1).max(MAX_PUZZLE_ATTEMPT_ID_LENGTH);
export const puzzleAttemptSchema = z.object({
    attemptId: attemptIdSchema,
    puzzle: puzzleSchema,
    /**
     * The database the row was drawn from. Row ids repeat across puzzle databases, so a later
     * lookup by `puzzle.id` is only valid against this database. Absent on attempts migrated
     * from legacy storage or persisted before it was recorded: their source is unknown.
     */
    database: pathRefSchema.optional(),
});
export type PuzzleAttempt = z.infer<typeof puzzleAttemptSchema>;

const sessionShape = z
    .object({
        version: z.literal(1),
        attempts: z.array(puzzleAttemptSchema),
        selectedAttemptId: attemptIdSchema.nullable(),
    })
    .superRefine((session, context) => {
        if (
            new Set(session.attempts.map((attempt) => attempt.attemptId)).size !==
            session.attempts.length
        ) {
            context.addIssue({ code: "custom", message: "Duplicate puzzle attempt identity" });
        }
    });
export type PuzzleSession = z.infer<typeof sessionShape>;

export function puzzleSessionBytes(session: PuzzleSession): number {
    return serializeStorageValue(session).length * 2;
}

/** A present invalid session gates the entire tree instead of silently losing its owner. */
export const puzzleSessionSchema = sessionShape.refine(
    (session) =>
        session.attempts.length <= MAX_PUZZLE_ATTEMPTS &&
        puzzleSessionBytes(session) <= MAX_PUZZLE_SESSION_BYTES,
    "Puzzle session exceeds its retention budget",
);

export function emptyPuzzleSession(): PuzzleSession {
    return { version: 1, attempts: [], selectedAttemptId: null };
}

/** A dangling identity stays unresolved and never implies selection of index zero. */
export function selectedPuzzleIndex(session: PuzzleSession | undefined): number {
    return (
        session?.attempts.findIndex((attempt) => attempt.attemptId === session.selectedAttemptId) ??
        -1
    );
}

function puzzleSessionQuotaError(): Error {
    return new Error(
        i18n.t("Common.StorageQuotaExceeded") ||
            enUSCatalogue.translation["Common.StorageQuotaExceeded"],
    );
}

/** Infer legacy ownership first. Migration passes [] because its rows are not new admissions. */
export function boundPuzzleSession(
    value: PuzzleSession,
    incomingAttemptIds: readonly string[] = value.attempts.map((attempt) => attempt.attemptId),
): PuzzleSession {
    const session = sessionShape.parse(value);
    const incoming = new Set(incomingAttemptIds);
    for (const attempt of session.attempts) {
        if (
            (incoming.has(attempt.attemptId) || attempt.attemptId === session.selectedAttemptId) &&
            puzzleSessionBytes({
                version: 1,
                attempts: [attempt],
                selectedAttemptId: attempt.attemptId,
            }) > MAX_PUZZLE_SESSION_BYTES
        ) {
            throw puzzleSessionQuotaError();
        }
    }
    while (
        session.attempts.length > MAX_PUZZLE_ATTEMPTS ||
        puzzleSessionBytes(session) > MAX_PUZZLE_SESSION_BYTES
    ) {
        const index = session.attempts.findIndex(
            (attempt) => attempt.attemptId !== session.selectedAttemptId,
        );
        if (index === -1) throw puzzleSessionQuotaError();
        session.attempts.splice(index, 1);
    }
    return session;
}

export const legacyPuzzleKey = (logicalId: string) => `${logicalId}${LEGACY_PUZZLE_SUFFIX}`;

/** The saved played path establishes ownership without replacing annotations or variations. */
export function puzzleOwnsTree(puzzle: Puzzle, tree: TreeState): boolean {
    if (
        getBoardState(puzzle.fen) !== getBoardState(tree.root.fen) ||
        getResolvedPathLength(tree.root, tree.position) !== tree.position.length
    )
        return false;
    if (getPuzzleProgress(puzzle, tree.root, tree.position).step !== null) return true;
    // An accepted alternative checkmate also terminates the existing puzzle contract.
    const prefix = tree.position.slice(0, -1);
    const [position] = positionFromFen(getNodeAtPath(tree.root, tree.position).fen);
    return (
        tree.position.length > 0 &&
        !!position?.isCheckmate() &&
        getPuzzleProgress(puzzle, tree.root, prefix).step !== null
    );
}

/** Legacy rows are independent. Infer before eviction, including duplicate database row IDs. */
export function restorePuzzleSession(logicalId: string, tree: TreeState): PuzzleSession {
    if (tree.puzzleSession) {
        const index = selectedPuzzleIndex(tree.puzzleSession);
        return index >= 0 && !puzzleOwnsTree(tree.puzzleSession.attempts[index].puzzle, tree)
            ? { ...tree.puzzleSession, selectedAttemptId: null }
            : tree.puzzleSession;
    }
    const raw = sessionStorage.getItem(legacyPuzzleKey(logicalId));
    const value = decodeCompressedOrJson(raw);
    const attempts: PuzzleAttempt[] = [];
    if (Array.isArray(value)) {
        for (const row of value) {
            const parsed = puzzleSchema.safeParse(row);
            if (parsed.success)
                attempts.push({ attemptId: crypto.randomUUID(), puzzle: parsed.data });
        }
    }
    const owners = attempts.filter(({ puzzle }) => puzzleOwnsTree(puzzle, tree));
    return boundPuzzleSession(
        {
            version: 1,
            attempts,
            selectedAttemptId: owners.length === 1 ? owners[0].attemptId : null,
        },
        [],
    );
}

/** Confirm absence before discharging exact-key cleanup authority. Refusals retain the intent. */
export function removeLegacyPuzzleKey(key: string): boolean {
    try {
        if (sessionStorage.getItem(key) !== null) sessionStorage.removeItem(key);
        return sessionStorage.getItem(key) === null;
    } catch (error) {
        reportPersistError(persistStorageWriteError(error));
        return false;
    }
}
