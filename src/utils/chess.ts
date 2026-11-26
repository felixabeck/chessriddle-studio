import { cancellationError, tauri } from "@/platform/tauri";
import { isAbsentHeader } from "@/state/gameSignature";
import { type Color, type Move, makeUci, parseUci, type Role } from "chessops";
import { type Chess, normalizeMove } from "chessops/chess";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { isPawns } from "chessops/pgn";
import { makeSan } from "chessops/san";
import { match } from "ts-pattern";
import type { FileWorkspaceHandle, Outcome, Score, Token } from "@/bindings";
import {
    type BasicAnnotation,
    isBasicAnnotation,
    isNagCode,
    nagGlyph,
    sortedNags,
} from "./annotation";
import { parseSanOrUci, positionFromFen } from "./chessops";
import { makePgnDrawings, PGN_COMMENT_COMMAND, toDrawShape } from "./drawings";
import { harmonicMean, mean } from "./misc";
import { DIAGRAM_MARKER, splitPgnComment } from "./pgnComment";
import {
    formatScore,
    getAccuracy,
    getCPLoss,
    getWinChance,
    INITIAL_SCORE,
    normalizeScore,
} from "./score";
import {
    createNode,
    applyGameEndLoadDefault,
    defaultTree,
    GAME_END_COMMAND,
    GAME_END_PROSE,
    REVIEW_MARK_COMMAND,
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

function safeComment(text: string): string {
    return text.replace(/\}/g, "");
}

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

    // Verbatim except for closing braces, which PGN comments cannot contain: it may hold
    // commands as well as prose, and neither is modeled on the tree.
    if (tree.startingComment && opt.comments) {
        moveText += `{${safeComment(tree.startingComment)}} `;
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
                const score = tree.score.value;
                content += match(score.type)
                    .with("cp", () => `[%eval ${formatScore(score)}${depth}] `)
                    .with("mate", () => `[%eval #${score.value}${depth}] `)
                    .with("dtz", () => "")
                    .exhaustive();
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
            content += `${safeComment(tree.commands)} `;
        }

        if (opt.comments && tree.reviewMark) {
            const separated = content.endsWith("{") || content.endsWith(" ");
            content += `${separated ? "" : " "}[%${REVIEW_MARK_COMMAND}]${
                tree.diagram || tree.comment !== "" ? " " : ""
            }`;
        }

        // The marker leads the prose: the diagram is shown above its comment.
        if (opt.comments && tree.diagram) {
            const separated = content.endsWith("{") || content.endsWith(" ");
            content += `${separated ? "" : " "}${DIAGRAM_MARKER}${tree.comment !== "" ? " " : ""}`;
        }

        if (opt.comments && tree.comment !== "") {
            content += safeComment(tree.comment);
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

/** The identity of a game for a report: its root FEN and mainline moves. */
export function reportRootFingerprint(fen: string, moves: string[]): string {
    return `${fen}\u0000${moves.join("\u0000")}`;
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
        pgnTag("Event", isAbsentHeader(game.event, "name") ? "?" : game.event) +
        pgnTag("Site", isAbsentHeader(game.site, "name") ? "?" : game.site) +
        pgnTag("Date", game.date || "????.??.??") +
        pgnTag("Round", game.round || "?") +
        pgnTag("White", isAbsentHeader(game.white, "name") ? "?" : game.white) +
        pgnTag("Black", isAbsentHeader(game.black, "name") ? "?" : game.black) +
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

/**
 * Soft line-length ceiling for PGN movetext, well below the native scanner's 1 MiB
 * `MAX_LINE_LEN`. Lines are broken between tokens outside `{…}` comments once adding
 * the next token would reach this limit, leaving ordinary games byte-identical.
 */
export const MAX_PGN_MOVETEXT_LINE_BYTES = 64 * 1024;

/**
 * Hard physical line-length limit enforced by the native PGN scanner (`MAX_LINE_LEN` in
 * `src-tauri/src/pgn.rs`, 1 MiB). A line reaching this length cannot be scanned back.
 */
export const MAX_PGN_SCANNER_LINE_BYTES = 1024 * 1024;

export function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i++;
            } else {
                bytes += 3;
            }
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

function wrapPgnMovetext(movetext: string): string {
    if (
        movetext.length * 3 < MAX_PGN_MOVETEXT_LINE_BYTES ||
        utf8ByteLength(movetext) < MAX_PGN_MOVETEXT_LINE_BYTES
    ) {
        return movetext;
    }
    const parts: string[] = [];
    let lineBytes = 0;
    let i = 0;
    const len = movetext.length;

    while (i < len) {
        const spaceStart = i;
        while (i < len && movetext[i] === " ") i++;
        const spaceRun = movetext.slice(spaceStart, i);
        if (i >= len) {
            parts.push(spaceRun);
            break;
        }

        const tokenStart = i;
        let inComment = false;
        while (i < len) {
            const ch = movetext[i];
            if (inComment) {
                if (ch === "}") inComment = false;
                i++;
            } else if (ch === "{") {
                inComment = true;
                i++;
            } else if (ch === " ") {
                break;
            } else {
                i++;
            }
        }
        const token = movetext.slice(tokenStart, i);

        const firstNl = token.indexOf("\n");
        const firstLineBytes =
            firstNl === -1 ? utf8ByteLength(token) : utf8ByteLength(token.slice(0, firstNl));

        if (
            spaceRun.length > 0 &&
            lineBytes > 0 &&
            lineBytes + spaceRun.length + firstLineBytes >= MAX_PGN_MOVETEXT_LINE_BYTES
        ) {
            parts.push("\n", token);
            lineBytes =
                firstNl === -1
                    ? firstLineBytes
                    : utf8ByteLength(token.slice(token.lastIndexOf("\n") + 1));
        } else {
            parts.push(spaceRun, token);
            if (firstNl === -1) {
                lineBytes += spaceRun.length + firstLineBytes;
            } else {
                lineBytes = utf8ByteLength(token.slice(token.lastIndexOf("\n") + 1));
            }
        }
    }
    return parts.join("");
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
    let headerPrefix = "";
    if (headers) {
        headerPrefix += headersToPGN(headers);
    }
    if (root && tree.fen !== INITIAL_FEN) {
        headerPrefix += '[SetUp "1"]\n';
        headerPrefix += `[FEN "${tree.fen}"]\n`;
    }
    if (root) {
        headerPrefix += "\n";
    }
    let movetext = "";
    if (root && tree.comment !== null) {
        movetext += `${getMoveText(tree, {
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
        movetext += getMoveText(child, {
            glyphs: glyphs,
            comments,
            extraMarkups,
            isFirst: root,
            omitGameEnd: child === omitGameEnd,
        });
    }
    if (!path) {
        for (const variation of variationsPGN) {
            movetext += ` (${variation}) `;
        }
    }

    if (tree.children.length > 0) {
        movetext += writePGN(
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
        movetext += ` ${headers.result}`;
    }
    if (root) {
        return (headerPrefix + wrapPgnMovetext(movetext)).trim();
    }
    return movetext.trim();
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

/** The full FENs from the root along `position`, stopping at the first index with no such child. */
export function openingLineFens(root: TreeNode, position: number[]): string[] {
    const fens: string[] = [root.fen];
    let currentNode = root;

    for (const index of position) {
        if (!currentNode.children || index >= currentNode.children.length) {
            break;
        }
        currentNode = currentNode.children[index];
        fens.push(currentNode.fen);
    }

    return fens;
}

export async function getOpening(root: TreeNode, position: number[]): Promise<string> {
    return await tauri.getOpeningFromFens(openingLineFens(root, position));
}

function innerParsePGN(
    tokens: Token[],
    losses: string[],
    moveLegalityFailures: string[],
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

            if (comment.diagram) node.diagram = true;
            if (comment.reviewMark && node !== tree.root) node.reviewMark = true;

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
            const newTree = innerParsePGN(
                variation,
                losses,
                moveLegalityFailures,
                prevNode.fen,
                prevNode.halfMoves,
            );
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
            moveLegalityFailures.push("Unparsed content");
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
                moveLegalityFailures.push("Invalid move position");
                continue;
            }
            const move = parseSanOrUci(pos, token.value);
            if (!move) {
                losses.push("Unplayable move");
                moveLegalityFailures.push("Unplayable move");
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

/**
 * Builds a `TreeState` from already-lexed PGN tokens, reporting move-legality failures
 * ("Invalid move position", "Unplayable move", "Unparsed content") separately from
 * preservation-only losses. Shared by single-game and multi-game PGN parsing.
 */
export function parsePgnTokens(
    tokens: Token[],
    initialFen?: string,
): { tree: TreeState; losses: string[]; moveLegalityFailures: string[] } {
    const headers = getPgnHeaders(tokens);
    const fen = initialFen?.trim() || headers.fen.trim();

    const losses: string[] = [];
    const moveLegalityFailures: string[] = [];
    const tree = innerParsePGN(tokens, losses, moveLegalityFailures, fen);
    // The validated path replaces the raw tag, so an unresolvable Start never reaches the store.
    const start = parseStartHeader(headers.start, tree.root);
    tree.headers = { ...headers, fen: tree.root.fen, start };
    tree.position = start;
    applyGameEndLoadDefault(tree);
    return { tree, losses, moveLegalityFailures };
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

    const { tree, losses } = parsePgnTokens(tokens, initialFen);
    if (options?.signal?.aborted) {
        throw cancellationError();
    }
    return { tree, losses };
}

export class PgnPageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PgnPageError";
    }
}

export type PgnGamePage = {
    start: number;
    games: Awaited<ReturnType<typeof tauri.readGames>>;
};

/**
 * Streams validated pages of PGN games from `handle` up to `totalGames`, advancing by each
 * returned page's length.
 *
 * - Aborts with `cancellationError()` before or after any read when `signal` is aborted.
 * - Requests `[next, min(totalGames - 1, next + pageSize - 1)]` via `tauri.readGames`.
 * - Throws `PgnPageError` if a page is empty before `totalGames`, overflows `totalGames`, or
 *   carries a `revision` different from `expectedRevision` (or the first game's revision when
 *   omitted).
 * - Propagates any error from `tauri.readGames` unchanged.
 */
export async function* readPgnGamePages(options: {
    handle: FileWorkspaceHandle;
    totalGames: number;
    pageSize: number;
    signal?: AbortSignal;
    expectedRevision?: string;
}): AsyncGenerator<PgnGamePage> {
    const { handle, totalGames, pageSize, signal } = options;
    let expectedRevision = options.expectedRevision ?? null;
    let next = 0;

    while (next < totalGames) {
        if (signal?.aborted) throw cancellationError();
        const end = Math.min(totalGames - 1, next + pageSize - 1);
        const games = await tauri.readGames(handle, next, end, signal ? { signal } : undefined);
        if (signal?.aborted) throw cancellationError();

        if (games.length === 0) {
            throw new PgnPageError(`Empty game page returned at chapter ${next} of ${totalGames}`);
        }
        if (next + games.length > totalGames) {
            throw new PgnPageError(
                `Game page exceeded counted chapters (${next + games.length} > ${totalGames})`,
            );
        }

        for (const game of games) {
            if (expectedRevision === null) {
                expectedRevision = game.revision;
            } else if (game.revision !== expectedRevision) {
                throw new PgnPageError(
                    `File revision changed during read (expected ${expectedRevision}, got ${game.revision})`,
                );
            }
        }

        yield { start: next, games };
        next += games.length;
    }
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
    let variationDepth = 0;

    for (const token of tokens) {
        if (token.type === "Header") {
            const { tag, value } = token.value;
            headersN.set(tag, decodePgnTagValue(value));
        } else if (token.type === "ParenOpen") {
            variationDepth += 1;
        } else if (token.type === "ParenClose") {
            if (variationDepth > 0) {
                variationDepth -= 1;
            }
        } else if (token.type === "Outcome" && variationDepth === 0 && token.value !== "*") {
            // Same mainline-marker rule as Importer::outcome in src-tauri/src/db/mod.rs.
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

export type AnnotationCounts = Record<BasicAnnotation, number>;

export type SideStats = {
    /** Game accuracy (0–100), or null when the side has no scored move. */
    accuracy: number | null;
    /** Average centipawn loss, or null when the side has no scored move. */
    acpl: number | null;
    annotations: AnnotationCounts;
};

/** A mainline move carrying one of the six move-quality marks. */
export type KeyMoment = {
    /** Mainline path of the move's node. */
    path: number[];
    halfMoves: number;
    san: string;
    annotation: BasicAnnotation;
    /** Saved evaluations (White-relative) before and after the move. */
    before: Score | null;
    after: Score | null;
    /** The first move of the report's better line at this point, when the tree has one. */
    betterMove: string | null;
};

export type GameStats = ColorMap<SideStats> & {
    keyMoments: KeyMoment[];
    /** Mainline positions, the root included, with a saved evaluation. */
    scoredPositions: number;
};

function emptyCounts(): AnnotationCounts {
    return { "??": 0, "?": 0, "?!": 0, "!!": 0, "!": 0, "!?": 0 };
}

/** Volatility weights of the moves of a game: bounds and window size (Lichess's method). */
const MIN_VOLATILITY_WEIGHT = 0.5;
const MAX_VOLATILITY_WEIGHT = 12;
const MIN_VOLATILITY_WINDOW = 2;
const MAX_VOLATILITY_WINDOW = 8;
/** Between the bounds, the window holds one position per this many moves. */
const MOVES_PER_VOLATILITY_WINDOW_POSITION = 10;

function populationStandardDeviation(values: number[]): number {
    const average = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

/**
 * The weight of each move (index `k − 1` for the move reaching position `k`): the population
 * standard deviation of the White-relative win chances of the `s` positions ending at `k`; the
 * first `s − 1` moves, whose own window would start before the root, use the first `s` positions
 * (Lichess pads `s − 2` copies before its first sliding window). A window with an unscored
 * position gets the minimum weight.
 */
function volatilityWeights(winChances: (number | null)[]): number[] {
    const moves = winChances.length - 1;
    const size = Math.min(
        MAX_VOLATILITY_WINDOW,
        Math.max(MIN_VOLATILITY_WINDOW, Math.floor(moves / MOVES_PER_VOLATILITY_WINDOW_POSITION)),
    );
    const weights: number[] = [];
    for (let k = 1; k <= moves; k++) {
        const end = Math.max(k, size - 1);
        const window = winChances.slice(end - size + 1, end + 1);
        weights.push(
            window.some((value) => value === null)
                ? MIN_VOLATILITY_WEIGHT
                : Math.min(
                      MAX_VOLATILITY_WEIGHT,
                      Math.max(
                          MIN_VOLATILITY_WEIGHT,
                          populationStandardDeviation(window as number[]),
                      ),
                  ),
        );
    }
    return weights;
}

/**
 * Everything the Report tab shows, from one walk over the mainline: per-side accuracy and ACPL,
 * the per-side counts of the six move-quality marks, and the key moments. It reads the saved
 * evaluation (`node.score`), never the live engine; a standard start position without one counts
 * as +0.15.
 */
export function getGameStats(root: TreeNode): GameStats {
    const annotations: ColorMap<AnnotationCounts> = { white: emptyCounts(), black: emptyCounts() };
    const cplosses: ColorMap<number[]> = { white: [], black: [] };
    const accuracies: ColorMap<{ accuracy: number; move: number }[]> = { white: [], black: [] };
    const keyMoments: KeyMoment[] = [];

    const rootScore = root.score ?? (root.fen === INITIAL_FEN ? INITIAL_SCORE : null);
    const winChances: (number | null)[] = [
        rootScore ? getWinChance(normalizeScore(rootScore.value, "white")) : null,
    ];
    let parentScore = rootScore;
    let scoredPositions = root.score ? 1 : 0;
    let node = root;
    const path: number[] = [];
    while (node.children.length > 0) {
        const parent = node;
        node = node.children[0];
        path.push(0);
        const color: Color = node.halfMoves % 2 === 1 ? "white" : "black";
        const score = node.score;
        let marked: BasicAnnotation | undefined;
        for (const code of node.nags) {
            const annotation = nagGlyph(code);
            if (annotation && isBasicAnnotation(annotation)) {
                annotations[color][annotation]++;
                marked ??= annotation;
            }
        }
        if (marked) {
            keyMoments.push({
                path: [...path],
                halfMoves: node.halfMoves,
                san: node.san ?? "",
                annotation: marked,
                before: parentScore,
                after: score,
                // A promoted report line keeps its marker at children[0]: it is the played move,
                // so the better move is a report line beside it.
                betterMove: parent.children.slice(1).find((child) => child.reportLine)?.san ?? null,
            });
        }
        if (parentScore && score) {
            cplosses[color].push(getCPLoss(parentScore.value, score.value, color));
            accuracies[color].push({
                accuracy: getAccuracy(parentScore.value, score.value, color),
                move: winChances.length - 1,
            });
        }
        if (score) scoredPositions++;
        winChances.push(score ? getWinChance(normalizeScore(score.value, "white")) : null);
        parentScore = score;
    }

    const weights = volatilityWeights(winChances);
    const side = (color: Color): SideStats => {
        const scored = accuracies[color];
        if (scored.length === 0) {
            return { accuracy: null, acpl: null, annotations: annotations[color] };
        }
        const harmonic = harmonicMean(scored.map((entry) => entry.accuracy));
        const totalWeight = scored.reduce((sum, entry) => sum + weights[entry.move], 0);
        const weighted =
            scored.reduce((sum, entry) => sum + entry.accuracy * weights[entry.move], 0) /
            totalWeight;
        return {
            accuracy: (harmonic + weighted) / 2,
            acpl: mean(cplosses[color]),
            annotations: annotations[color],
        };
    };
    return { white: side("white"), black: side("black"), keyMoments, scoredPositions };
}

export type PiecesCount = {
    p: number;
    n: number;
    b: number;
    r: number;
    q: number;
};

/** The capturable roles in ascending value, keyed as in `PiecesCount`. */
export const MATERIAL_ROLES: readonly { key: keyof PiecesCount; role: Role }[] = [
    { key: "p", role: "pawn" },
    { key: "n", role: "knight" },
    { key: "b", role: "bishop" },
    { key: "r", role: "rook" },
    { key: "q", role: "queen" },
];

export function getMaterialDiff(fen: string) {
    const res = parseFen(fen);
    if (res.isErr) {
        return null;
    }
    const board = res.unwrap().board;
    const { white, black } = board;

    const startingCounts = { p: 8, n: 2, b: 2, r: 2, q: 1 };

    const pieces: PiecesCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const whiteCaptured: PiecesCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const blackCaptured: PiecesCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    let whitePromotions = 0;
    let blackPromotions = 0;

    for (const { key, role } of MATERIAL_ROLES) {
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
