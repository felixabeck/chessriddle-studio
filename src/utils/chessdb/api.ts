import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { z } from "zod";
import type { BestMoves, EngineOptions, GoMode, ScoreValue } from "@/bindings";
import { remoteHttp } from "@/platform/http";
import { positionFromFen } from "../chessops";
import { getBoardState } from "../treeReducer";
import { replayUciMoves } from "../chess";
import { engineMultiPv } from "../engines";

const endpoint = "https://www.chessdb.cn/cdb.php";

export type ChessDBLine = BestMoves & {
    chessdb?: { note: string; winrate?: string };
};

export type ChessDBOutcome = [number, ChessDBLine[]] | { type: "not-in-database" } | null;

const chessDbMoveSchema = z.object({
    uci: z.string(),
    san: z.string(),
    score: z.number(),
    rank: z.number(),
    note: z.string(),
    winrate: z.string().optional(),
});
const statusSchema = z.object({ status: z.string() }).passthrough();
const nonOkSchema = z.object({ status: z.string().refine((status) => status !== "ok") });
const allOkSchema = z.object({
    status: z.literal("ok"),
    moves: z.array(chessDbMoveSchema),
});
const bestOkSchema = z.object({
    status: z.literal("ok"),
    depth: z.number(),
    score: z.number(),
    pv: z.array(z.string()),
    pvSAN: z.array(z.string()),
});
const allResponseSchema = statusSchema.pipe(z.union([allOkSchema, nonOkSchema]));
const bestResponseSchema = statusSchema.pipe(z.union([bestOkSchema, nonOkSchema]));

// Each action retains at most 128 positions (256 entries total), plus bounded pending requests.
export const CHESSDB_CACHE_CAPACITY = 128;
export const CHESSDB_MAX_IN_FLIGHT = 128;
export const CHESSDB_QUEUE_CAPACITY = 128;
// Cap displayed lines and concurrent child PV requests to match LinesSlider's 1..5 policy.
export const CHESSDB_MAX_MULTIPV = 5;

class PositionRequests<T> {
    private cache = new Map<string, T>();
    private pending = new Map<string, Promise<T>>();

    get(fen: string, load: () => Promise<T>, cacheable: (value: T) => boolean): Promise<T> {
        const key = getBoardState(fen);
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            this.cache.delete(key);
            this.cache.set(key, cached);
            return Promise.resolve(cached);
        }
        const pending = this.pending.get(key);
        if (pending) return pending;
        if (this.pending.size >= CHESSDB_MAX_IN_FLIGHT)
            return Promise.reject(new Error("Too many pending ChessDB requests"));
        const request = load()
            .then((value) => {
                if (cacheable(value)) {
                    this.cache.set(key, value);
                    if (this.cache.size > CHESSDB_CACHE_CAPACITY) {
                        const oldest = this.cache.keys().next().value;
                        if (oldest !== undefined) this.cache.delete(oldest);
                    }
                }
                return value;
            })
            .finally(() => this.pending.delete(key));
        this.pending.set(key, request);
        return request;
    }
}

const moveLists = new PositionRequests<z.infer<typeof allResponseSchema>>();
const childPvs = new PositionRequests<z.infer<typeof bestResponseSchema>>();
const queuedPositions = new Set<string>();

function requestUrl(action: string, fen: string) {
    const url = new URL(endpoint);
    url.searchParams.set("action", action);
    url.searchParams.set("json", "1");
    url.searchParams.set("board", fen);
    if (action === "querypv") url.searchParams.set("stable", "1");
    return url.toString();
}

function queuePosition(fen: string) {
    const key = getBoardState(fen);
    const queued = queuedPositions.has(key);
    queuedPositions.delete(key);
    queuedPositions.add(key);
    if (queuedPositions.size > CHESSDB_QUEUE_CAPACITY) {
        const oldest = queuedPositions.values().next().value;
        if (oldest !== undefined) queuedPositions.delete(oldest);
    }
    if (!queued)
        void remoteHttp.get(requestUrl("queue", fen), { schema: statusSchema }).catch(() => {});
}

export async function getBestMoves(
    _tab: string,
    _goMode: GoMode,
    options: EngineOptions,
): Promise<ChessDBOutcome> {
    const [pos] = positionFromFen(options.fen);
    if (!pos) {
        return null;
    }
    for (const uci of options.moves) {
        const m = parseUci(uci);
        if (!m || !pos.isLegal(m)) {
            return null;
        }
        pos.play(m);
    }
    const fen = makeFen(pos.toSetup());
    const response = await moveLists.get(
        fen,
        () => remoteHttp.get(requestUrl("queryall", fen), { schema: allResponseSchema }),
        (value) => "moves" in value && value.moves.length > 0,
    );
    if (response.status === "unknown" || ("moves" in response && response.moves.length === 0)) {
        queuePosition(fen);
        return { type: "not-in-database" };
    }
    if (!("moves" in response)) throw new Error(`ChessDB lookup failed (${response.status})`);
    const multipv = Math.min(CHESSDB_MAX_MULTIPV, engineMultiPv(options.extraOptions));
    const lines = await Promise.all(
        response.moves.slice(0, multipv).map(async (move, i): Promise<ChessDBLine> => {
            const child = pos.clone();
            const { uciMoves, sanMoves } = replayUciMoves(child, [move.uci]);
            let depth = 0;
            if (uciMoves.length > 0) {
                const childFen = makeFen(child.toSetup());
                try {
                    const pv = await childPvs.get(
                        childFen,
                        () =>
                            remoteHttp.get(requestUrl("querypv", childFen), {
                                schema: bestResponseSchema,
                            }),
                        (value) => "pv" in value,
                    );
                    if ("pv" in pv) {
                        depth = pv.depth;
                        const continuation = replayUciMoves(child, pv.pv);
                        uciMoves.push(...continuation.uciMoves);
                        sanMoves.push(...continuation.sanMoves);
                    }
                } catch {
                    // A missing child PV leaves the ranked move available.
                }
            }
            return {
                score: {
                    value: chessDBevalToScore(pos.turn === "black" ? -move.score : move.score),
                    wdl: null,
                },
                nodes: 0n,
                depth,
                multipv: i + 1,
                nps: 0n,
                sanMoves,
                uciMoves,
                chessdb: { note: move.note, winrate: move.winrate },
            };
        }),
    );
    return [100, lines.filter((line) => line.uciMoves.length > 0)];
}

function chessDBevalToScore(score: number): ScoreValue {
    if (Math.abs(score) > 250_00) {
        return {
            type: "mate",
            value: Math.floor((300_00 - Math.abs(score) + 1) / 2) * (score > 0 ? 1 : -1),
        };
    }
    if (Math.abs(score) > 200_00) {
        return {
            type: "dtz",
            value: (250_00 - Math.abs(score)) * (score > 0 ? 1 : -1),
        };
    }
    if (Math.abs(score) > 150_00) {
        return {
            type: "dtz",
            value: (200_00 - Math.abs(score)) * (score > 0 ? 1 : -1),
        };
    }

    return { type: "cp", value: score };
}
