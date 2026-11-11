import { cancellationError, tauri } from "@/platform/tauri";
import { type Color, type Move, makeUci, parseUci, type Role } from "chessops";
import { type Chess, normalizeMove } from "chessops/chess";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { isPawns } from "chessops/pgn";
import { makeSan } from "chessops/san";
import { type Outcome, type Score, type Token } from "@/bindings";
import { isBasicAnnotation, isNagCode, nagGlyph, sortedNags } from "./annotation";
import { parseSanOrUci, positionFromFen } from "./chessops";
import { makePgnDrawings, PGN_COMMENT_COMMAND, toDrawShape } from "./drawings";
import { harmonicMean, isPrefix, mean } from "./misc";
import { splitPgnComment } from "./pgnComment";
import { formatScore, getAccuracy, getCPLoss, INITIAL_SCORE } from "./score";
import {
    createNode,
    applyGameEndLoadDefault,
    defaultTree,
    GAME_END_COMMAND,
    GAME_END_PROSE,
    getEffectiveGameEnd,
    getEffectiveTermination,
    getResolvedPathLength,
    normalizeFen,
    sanitizeGameEndTermination,
    type GameHeaders,
    type TreeNode,
    type TreeState,
} from "./treeReducer";

const MAX_START_PATH_LENGTH = 512;

export interface BestMoves {
    depth: number;
    score: Score;
    uciMoves: string[];
    sanMoves: string[];
    multipv: number;
    nps: number;
}

export interface MoveAnalysis {
    best: BestMoves[];
    novelty: boolean;
    is_sacrifice: boolean;
}

// copied from chessops
export const makeClk = (seconds: number): string => {
    let s = Math.max(0, seconds);
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    s = (s % 3600) % 60;
    return `${hours}:${minutes.toString().padStart(2, "0")}:${s.toLocaleString("en", {
        minimumIntegerDigits: 2,
        maximumFractionDigits: 3,
    })}`;
};

export function getMoveText(
    tree: TreeNode,
    opt: {
        glyphs: boolean;
        comments: boolean;
        extraMarkups: boolean;
        isFirst?: boolean;
        omitGameEnd?: boolean;
    },
): string {
    const isBlack = tree.halfMoves % 2 === 0;
    const moveNumber = Math.ceil(tree.halfMoves / 2);
    let moveText = "";

    // Verbatim: it may hold commands as well as prose, and neither is modeled on the tree.
    if (tree.startingComment && opt.comments) {
        moveText += `{${tree.startingComment}} `;
    }

    if (tree.san) {
        if (isBlack) {
            if (opt.isFirst) {
                moveText += `${moveNumber}... `;
            }
        } else {
            moveText += `${moveNumber}. `;
        }
        moveText += tree.san;
        if (opt.glyphs) {
            for (const [index, code] of sortedNags(tree.nags).entries()) {
                const glyph = nagGlyph(code);
                moveText += index === 0 && glyph && isBasicAnnotation(glyph) ? glyph : ` $${code}`;
            }
        }
        moveText += " ";
    }

    if (opt.comments || opt.extraMarkups) {
        let content = "{";

        if (opt.extraMarkups) {
            if (tree.score !== null) {
                const depth = tree.depth === null ? "" : `,${tree.depth}`;
                if (tree.score.value.type === "cp") {
                    content += `[%eval ${formatScore(tree.score.value)}${depth}] `;
                } else {
                    content += `[%eval #${tree.score.value.value}${depth}] `;
                }
            }
            if (tree.clock !== undefined) {
                content += `[%clk ${makeClk(tree.clock)}] `;
            }
        }

        if (opt.extraMarkups && tree.shapes.length > 0) {
            content += makePgnDrawings(tree.shapes);
        }

        // They were part of the comment text before the tree modeled them, so they travel with the
        // comments: an "Update" from a PGN shown without extra markups must not drop them.
        if (opt.comments && tree.commands) {
            content += `${tree.commands} `;
        }

        if (opt.comments && tree.comment !== "") {
            content += tree.comment;
        }
        content += "} ";

        if (content !== "{} ") {
            moveText += content;
        }
    }
    if (opt.comments && tree.san && tree.gameEnd && !opt.omitGameEnd) {
        const termination = sanitizeGameEndTermination(tree.gameEnd.termination ?? "");
        moveText += `{[%${GAME_END_COMMAND}${termination ? ` ${termination}` : ""}] ${GAME_END_PROSE}} `;
    }
    return moveText;
}

export function getLastMainlinePosition(root: TreeNode): number[] {
    const position = [];
    for (let node = root; node.children.length > 0; node = node.children[0]) {
        position.push(0);
    }
    return position;
}

export function getMainLine(root: TreeNode): string[] {
    return getVariationLine(root, getLastMainlinePosition(root));
}

export function uciNormalize(chess: Chess, move: Move) {
    const frcMove = normalizeMove(chess, move);
    return makeUci(frcMove);
}

// Advance the supplied position through the legal prefix, keeping UCI and SAN index-aligned.
export function replayUciMoves(pos: Chess, moves: readonly string[]) {
    const uciMoves: string[] = [];
    const sanMoves: string[] = [];
    for (const uci of moves) {
        const move = parseUci(uci);
        if (!move || !pos.isLegal(move)) break;
        uciMoves.push(uciNormalize(pos, move));
        sanMoves.push(makeSan(pos, move));
        pos.play(move);
    }
    return { uciMoves, sanMoves };
}

export function getVariationLine(root: TreeNode, position: number[]): string[] {
    const moves = [];
    let node = root;
    const [chess] = positionFromFen(root.fen);
    if (!chess) {
        return [];
    }
    for (const pos of position) {
        node = node.children[pos];
        if (node.move) {
            moves.push(uciNormalize(chess, node.move));
            chess.play(node.move);
        }
    }
    return moves;
}

function pgnTag(name: string, value: string | number): string {
    return `[${name} "${String(value).replace(/[\\"]/g, "\\$&")}"]\n`;
}

export function decodePgnTagValue(value: string): string {
    return value.replace(/\\([\\"])/g, "$1");
}

export function headersToPGN(game: GameHeaders): string {
    let headers =
        pgnTag("Event", game.event || "?") +
        pgnTag("Site", game.site || "?") +
        pgnTag("Date", game.date || "????.??.??") +
        pgnTag("Round", game.round || "?") +
        pgnTag("White", game.white || "?") +
        pgnTag("Black", game.black || "?") +
        pgnTag("Result", game.result);
    if (game.time) {
        headers += pgnTag("UTCTime", game.time);
    }
    const whiteElo = game.white_elo;
    const blackElo = game.black_elo;
    const emitWhiteElo = typeof whiteElo === "number" && Number.isFinite(whiteElo);
    const emitBlackElo = typeof blackElo === "number" && Number.isFinite(blackElo);
    if (emitWhiteElo) {
        headers += pgnTag("WhiteElo", whiteElo === 0 ? "-" : whiteElo);
    }
    if (emitBlackElo) {
        headers += pgnTag("BlackElo", blackElo === 0 ? "-" : blackElo);
    }
    if (game.start && game.start.length > 0) {
        headers += pgnTag("Start", JSON.stringify(game.start));
    }
    if (game.orientation) {
        headers += pgnTag("Orientation", game.orientation);
    }
    if (game.time_control) {
        headers += pgnTag("TimeControl", game.time_control);
    }
    if (game.white_time_control) {
        headers += pgnTag("WhiteTimeControl", game.white_time_control);
    }
    if (game.black_time_control) {
        headers += pgnTag("BlackTimeControl", game.black_time_control);
    }
    if (game.eco) {
        headers += pgnTag("ECO", game.eco);
    }
    if (game.variant) {
        headers += pgnTag("Variant", game.variant);
    }
    for (const [key, value] of Object.entries(game.other ?? {})) {
        // writePGN owns root-position tags; skip copies persisted in `other` before they were modeled.
        if (
            (key === "WhiteElo" && emitWhiteElo) ||
            (key === "BlackElo" && emitBlackElo) ||
            key === "SetUp" ||
            key === "FEN"
        ) {
            continue;
        }
        headers += pgnTag(key, value);
    }
    return headers;
}

export function defaultPGN() {
    return `[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n\n*`;
}

export function getPGN(tree: TreeNode, options: Parameters<typeof writePGN>[1]): string {
    const end = getEffectiveGameEnd(tree);
    const termination = options.headers
        ? getEffectiveTermination({ root: tree, headers: options.headers })
        : undefined;
    const headers = options.headers && {
        ...options.headers,
        other: { ...options.headers.other },
    };
    if (headers) {
        delete headers.other.Termination;
        if (termination !== undefined) headers.other.Termination = termination;
    }
    const omitGameEnd =
        end &&
        end.node.children.length === 0 &&
        end.node.gameEnd?.termination === undefined &&
        headers &&
        headers.result !== "*"
            ? end.node
            : undefined;
    return writePGN(tree, { ...options, headers }, omitGameEnd);
}

function writePGN(
    tree: TreeNode,
    {
        headers,
        glyphs,
        comments,
        variations,
        extraMarkups,
        root = true,
        path = null,
    }: {
        headers: GameHeaders | null;
        glyphs: boolean;
        comments: boolean;
        variations: boolean;
        extraMarkups: boolean;
        root?: boolean;
        path?: number[] | null;
    },
    omitGameEnd?: TreeNode,
): string {
    if (path && path.length === 0) {
        return "";
    }
    let pgn = "";
    if (headers) {
        pgn += headersToPGN(headers);
    }
    if (root && tree.fen !== INITIAL_FEN) {
        pgn += '[SetUp "1"]\n';
        pgn += `[FEN "${tree.fen}"]\n`;
    }
    pgn += "\n";
    if (root && tree.comment !== null) {
        pgn += `${getMoveText(tree, {
            glyphs,
            comments,
            extraMarkups,
        })}`;
    }
    const variationsPGN = variations
        ? tree.children.slice(1).map(
              (variation) =>
                  `${getMoveText(variation, {
                      glyphs,
                      comments,
                      extraMarkups,
                      isFirst: true,
                      omitGameEnd: variation === omitGameEnd,
                  })} ${writePGN(
                      variation,
                      {
                          headers: null,
                          glyphs,
                          comments,
                          variations,
                          extraMarkups,
                          root: false,
                          path: null,
                      },
                      omitGameEnd,
                  )}`,
          )
        : [];
    if (tree.children.length > 0) {
        const child = tree.children[path ? path[0] : 0];
        pgn += getMoveText(child, {
            glyphs: glyphs,
            comments,
            extraMarkups,
            isFirst: root,
            omitGameEnd: child === omitGameEnd,
        });
    }
    if (!path) {
        for (const variation of variationsPGN) {
            pgn += ` (${variation}) `;
        }
    }

    if (tree.children.length > 0) {
        pgn += writePGN(
            tree.children[path ? path[0] : 0],
            {
                headers: null,
                glyphs,
                comments,
                variations,
                extraMarkups,
                root: false,
                path: path ? path.slice(1) : null,
            },
            omitGameEnd,
        );
    }
    if (root && headers) {
        pgn += ` ${headers.result}`;
    }
    return pgn.trim();
}

export function parseKeyboardMove(san: string, fen: string) {
    function cleanSan(san: string) {
        // Normalize castling: O, o, or 0 with optional hyphens
        if (/^[oO0]-?[oO0]-?[oO0]$/.test(san)) return "O-O-O";
        if (/^[oO0]-?[oO0]$/.test(san)) return "O-O";
        // Uppercase piece letters for non-castling moves
        return san.replace(/^([kqbnr])/i, (_, match) => match.toUpperCase());
    }

    const [pos] = positionFromFen(fen);
    if (!pos) {
        return null;
    }
    const move = parseSanOrUci(pos, san);
    if (move) {
        return move;
    }
    const newSan = cleanSan(san);
    const newMove = parseSanOrUci(pos, newSan);
    if (newMove) {
        return newMove;
    }
    return null;
}

export async function getOpening(root: TreeNode, position: number[]): Promise<string> {
    const fens: string[] = [root.fen];
    let currentNode = root;

    for (const index of position) {
        if (!currentNode.children || index >= currentNode.children.length) {
            break;
        }
        currentNode = currentNode.children[index];
        fens.push(currentNode.fen);
    }

    return await tauri.getOpeningFromFens(fens);
}

function innerParsePGN(
    tokens: Token[],
    losses: string[],
    fen: string = INITIAL_FEN,
    halfMoves?: number,
): TreeState {
    const tree = defaultTree(fen);
    // Only the recursive variation call passes halfMoves.
    const isVariation = halfMoves !== undefined;
    // The cursor: the node the next comment, NAG or move attaches to.
    let node = tree.root;
    let prevNode = node;
    let ended = false;
    let clocks = 0;
    let evaluations = 0;
    if (halfMoves !== undefined) node.halfMoves = halfMoves;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (ended && (token.type !== "Comment" || isVariation)) {
            losses.push("Content after outcome");
            continue;
        }

        if (token.type === "Comment") {
            for (const match of token.value.matchAll(PGN_COMMENT_COMMAND)) {
                // Use the same command reduction as the comment branch, including its
                // definition of a well-formed clock or evaluation.
                const field = splitPgnComment(match[0]);
                if (field.clock !== undefined && ++clocks > 1) losses.push("Multiple clocks");
                if (field.evaluation && ++evaluations > 1) losses.push("Multiple evaluations");
            }
            if (isVariation && node === tree.root) {
                losses.push("Comment on discarded variation root");
            }
            const comment = splitPgnComment(token.value, node !== tree.root);
            for (const gameEnd of comment.gameEnds) {
                if (node.gameEnd) losses.push("Multiple game ends on one node");
                else node.gameEnd = gameEnd;
            }

            if (comment.evaluation) {
                if (isPawns(comment.evaluation)) {
                    node.score = {
                        value: {
                            type: "cp",
                            value: comment.evaluation.pawns * 100,
                        },
                        wdl: null,
                    };
                } else {
                    node.score = {
                        value: {
                            type: "mate",
                            value: comment.evaluation.mate,
                        },
                        wdl: null,
                    };
                }
                // Paired with the score it came with, so a save writes `[%eval x,depth]` back.
                node.depth = comment.evaluation.depth ?? null;
            }

            if (comment.shapes.length > 0) {
                node.shapes.push(...comment.shapes.map(toDrawShape));
            }

            if (comment.clock !== undefined) {
                node.clock = comment.clock;
            }

            if (comment.text) {
                // Match starting comments: a space replaces the boundary between comment tokens.
                node.comment = node.comment ? `${node.comment} ${comment.text}` : comment.text;
            }
            if (comment.commands) {
                // The space stands in for the braces around this comment, so `commands` never
                // grows past its source.
                node.commands = node.commands
                    ? `${node.commands} ${comment.commands}`
                    : comment.commands;
            }
        } else if (token.type === "ParenOpen") {
            const variation: Token[] = [];
            let subvariations = 0;
            i++;
            while (i < tokens.length && (subvariations > 0 || tokens[i].type !== "ParenClose")) {
                if (tokens[i].type === "ParenOpen") {
                    subvariations++;
                } else if (tokens[i].type === "ParenClose") {
                    subvariations--;
                }
                variation.push(tokens[i]);
                i++;
            }
            // A comment before the variation's first move belongs to that move, not to the
            // throwaway node the recursive parse would put it on.
            const startingComments: string[] = [];
            let leading = variation[0];
            while (leading?.type === "Comment") {
                startingComments.push(leading.value);
                variation.shift();
                leading = variation[0];
            }
            const newTree = innerParsePGN(variation, losses, prevNode.fen, prevNode.halfMoves);
            // `newTree.root` stands for `prevNode` itself, so every child it has is an
            // alternative from `prevNode` — a variation nested at the variation's first move included.
            const [first] = newTree.root.children;
            if (first && startingComments.length > 0) {
                if (first.startingComment) losses.push("Overwritten variation starting comment");
                first.startingComment = startingComments.join(" ");
            } else if (startingComments.length > 0) {
                losses.push("Starting comment without a variation move");
            }
            prevNode.children.push(...newTree.root.children);
        } else if (token.type === "ParenClose") {
            losses.push("Unmatched variation close");
        } else if (token.type === "Unparsed") {
            losses.push("Unparsed content");
        } else if (token.type === "Nag") {
            const code = /^\$\d+$/.test(token.value) ? Number(token.value.slice(1)) : NaN;
            if (isNagCode(code)) {
                if (node === tree.root) losses.push("NAG on parse root");
                node.nags.push(code);
            } else {
                losses.push("Invalid NAG");
            }
        } else if (token.type === "San") {
            const [pos, error] = positionFromFen(node.fen);
            if (error) {
                losses.push("Invalid move position");
                continue;
            }
            const move = parseSanOrUci(pos, token.value);
            if (!move) {
                losses.push("Unplayable move");
                continue;
            }
            const san = makeSan(pos, move);
            pos.play(move);

            const newTree = createNode({
                fen: makeFen(pos.toSetup()),
                move,
                san,
                halfMoves: node.halfMoves + 1,
            });
            node.children.push(newTree);

            prevNode = node;
            node = newTree;
            clocks = 0;
            evaluations = 0;
        } else if (token.type === "Outcome") {
            if (isVariation) losses.push("Outcome inside variation");
            ended = true;
        }
    }
    return tree;
}

export async function parsePGN(
    pgn: string,
    initialFen?: string,
    options?: { signal?: AbortSignal },
): Promise<TreeState> {
    return (await parsePGNWithLossReport(pgn, initialFen, options)).tree;
}

/** Parse once, reporting content the tree cannot preserve when saved. */
export async function parsePGNWithLossReport(
    pgn: string,
    initialFen?: string,
    options?: { signal?: AbortSignal },
): Promise<{ tree: TreeState; losses: string[] }> {
    if (options?.signal?.aborted) {
        throw cancellationError();
    }
    const tokens = await tauri.lexPgn(pgn, options);
    if (options?.signal?.aborted) {
        throw cancellationError();
    }

    const headers = getPgnHeaders(tokens);
    const fen = initialFen?.trim() || headers.fen.trim();

    const losses: string[] = [];
    const tree = innerParsePGN(tokens, losses, fen);
    // The validated path replaces the raw tag, so an unresolvable Start never reaches the store.
    const start = parseStartHeader(headers.start, tree.root);
    tree.headers = { ...headers, fen: tree.root.fen, start };
    tree.position = start;
    applyGameEndLoadDefault(tree);
    if (options?.signal?.aborted) {
        throw cancellationError();
    }
    return { tree, losses };
}

/**
 * `Start` is user-controlled PGN metadata.  Keep it bounded and prove that it
 * names an existing branch before it becomes renderer state.
 */
export function parseStartHeader(start: unknown, root: TreeNode): number[] {
    if (!Array.isArray(start) || start.length > MAX_START_PATH_LENGTH) return [];
    if (getResolvedPathLength(root, start) !== start.length) return [];
    return start.filter((value): value is number => typeof value === "number");
}

/**
 * "-" is unrated (0). A trimmed all-digit tag becomes that integer. Any other
 * non-empty tag is stored under its original key in `other` so it round-trips
 * instead of becoming NaN.
 */
function parseEloTag(
    raw: string | undefined,
    key: "WhiteElo" | "BlackElo",
    other: Record<string, string>,
): number | undefined {
    if (!raw) return undefined;
    if (raw === "-") return 0;
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isSafeInteger(parsed)) return parsed;
    }
    other[key] = raw;
    return undefined;
}

// Keep file-open hydration aligned with normalize_pgn_result in src-tauri/src/db/mod.rs.
function normalizePgnResult(value: string | undefined): Outcome {
    switch (value?.trim()) {
        case "1-0":
            return "1-0";
        case "0-1":
            return "0-1";
        case "1/2-1/2":
        case "1/2":
        case "½-½":
            return "1/2-1/2";
        default:
            return "*";
    }
}

function getPgnHeaders(tokens: Token[]): GameHeaders {
    const headersN = new Map<string, string>();

    for (const token of tokens) {
        if (token.type === "Header") {
            const { tag, value } = token.value;
            headersN.set(tag, decodePgnTagValue(value));
        } else if (token.type === "Outcome") {
            headersN.set("Result", token.value);
        }
    }

    const {
        Black,
        White,
        BlackElo,
        WhiteElo,
        Date,
        Site,
        Event,
        Result,
        FEN,
        Round,
        Start,
        Orientation,
        TimeControl,
        Variant,
        WhiteTimeControl,
        BlackTimeControl,
        ECO,
        UTCTime,
        SetUp: _SetUp,
        ...other
    } = Object.fromEntries(headersN);

    const isValidOrientation = (value: string): value is "white" | "black" => {
        return ["white", "black"].includes(value);
    };

    const headers: GameHeaders = {
        id: 0,
        fen: normalizeFen(FEN),
        result: normalizePgnResult(Result),
        black: Black ?? "?",
        white: White ?? "?",
        round: Round ?? "?",
        black_elo: parseEloTag(BlackElo, "BlackElo", other),
        white_elo: parseEloTag(WhiteElo, "WhiteElo", other),
        date: Date ?? "",
        site: Site ?? "",
        event: Event ?? "",
        start: parseRawStartHeader(Start),
        ...(isValidOrientation(Orientation) ? { orientation: Orientation } : {}),
        time_control: TimeControl,
        white_time_control: WhiteTimeControl,
        black_time_control: BlackTimeControl,
        eco: ECO,
        time: UTCTime,
        variant: Variant,
        other: other,
    };
    return headers;
}

function parseRawStartHeader(value: string | undefined): number[] | undefined {
    if (!value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        if (
            !Array.isArray(parsed) ||
            parsed.length > MAX_START_PATH_LENGTH ||
            !parsed.every((item) => Number.isSafeInteger(item) && item >= 0)
        ) {
            return [];
        }
        return parsed;
    } catch {
        return [];
    }
}

type ColorMap<T> = {
    [key in Color]: T;
};

export function getGameStats(root: TreeNode) {
    const whiteAnnotations = {
        "??": 0,
        "?": 0,
        "?!": 0,
        "!!": 0,
        "!": 0,
        "!?": 0,
    };

    const blackAnnotations = {
        "??": 0,
        "?": 0,
        "?!": 0,
        "!!": 0,
        "!": 0,
        "!?": 0,
    };

    if (root.children.length === 0) {
        return {
            whiteCPL: 0,
            blackCPL: 0,
            whiteAccuracy: 0,
            blackAccuracy: 0,
            whiteAnnotations,
            blackAnnotations,
        };
    }

    let prevScore: Score = root.score ?? INITIAL_SCORE;
    const cplosses: ColorMap<number[]> = {
        white: [],
        black: [],
    };
    const accuracies: ColorMap<number[]> = {
        white: [],
        black: [],
    };
    let node = root;
    while (node.children.length > 0) {
        node = node.children[0];
        for (const code of node.nags) {
            const annotation = nagGlyph(code);
            if (annotation && isBasicAnnotation(annotation)) {
                if (node.halfMoves % 2 === 1) {
                    whiteAnnotations[annotation]++;
                } else {
                    blackAnnotations[annotation]++;
                }
            }
        }
        const color = node.halfMoves % 2 === 1 ? "white" : "black";
        if (node.score) {
            cplosses[color].push(getCPLoss(prevScore.value, node.score.value, color));
            accuracies[color].push(getAccuracy(prevScore.value, node.score.value, color));
            prevScore = node.score;
        }
    }
    const whiteCPL = mean(cplosses.white);
    const blackCPL = mean(cplosses.black);
    const whiteAccuracy = harmonicMean(accuracies.white);
    const blackAccuracy = harmonicMean(accuracies.black);

    return {
        whiteCPL,
        blackCPL,
        whiteAccuracy,
        blackAccuracy,
        whiteAnnotations,
        blackAnnotations,
    };
}

export type PiecesCount = {
    p: number;
    n: number;
    b: number;
    r: number;
    q: number;
};

export function getMaterialDiff(fen: string) {
    const res = parseFen(fen);
    if (res.isErr) {
        return null;
    }
    const board = res.unwrap().board;
    const { white, black } = board;

    const startingCounts = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    const roles: { key: keyof PiecesCount; role: Role }[] = [
        { key: "p", role: "pawn" },
        { key: "n", role: "knight" },
        { key: "b", role: "bishop" },
        { key: "r", role: "rook" },
        { key: "q", role: "queen" },
    ];

    const pieces: PiecesCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const whiteCaptured: PiecesCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const blackCaptured: PiecesCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    let whitePromotions = 0;
    let blackPromotions = 0;

    for (const { key, role } of roles) {
        const whiteCount = white.intersect(board[role]).size();
        const blackCount = black.intersect(board[role]).size();
        pieces[key] = whiteCount - blackCount;
        whiteCaptured[key] = Math.max(0, startingCounts[key] - blackCount);
        blackCaptured[key] = Math.max(0, startingCounts[key] - whiteCount);
        if (key !== "p") {
            whitePromotions += Math.max(0, whiteCount - startingCounts[key]);
            blackPromotions += Math.max(0, blackCount - startingCounts[key]);
        }
    }

    // Surplus pieces account for promoted pawns, not captures. FEN alone cannot reveal
    // promotions that replaced captured pieces or promoted pieces that were later captured.
    whiteCaptured.p = Math.max(0, whiteCaptured.p - blackPromotions);
    blackCaptured.p = Math.max(0, blackCaptured.p - whitePromotions);

    const diff = pieces.p * 1 + pieces.n * 3 + pieces.b * 3 + pieces.r * 5 + pieces.q * 9;

    return { pieces, whiteCaptured, blackCaptured, diff };
}

export function stripClock(fen: string): string {
    return fen.split(" ").slice(0, -2).join(" ");
}

export function hasMorePriority(position1: number[], position2: number[]): boolean {
    if (isPrefix(position1, position2)) {
        return true;
    }

    // remove common beggining of the arrays
    let i = 0;
    while (i < position1.length && i < position2.length && position1[i] === position2[i]) {
        i++;
    }

    return position1[i] < position2[i];
}
