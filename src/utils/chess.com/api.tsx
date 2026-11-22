import { tauri, withDownloadTicket } from "@/platform/tauri";
import { notifications } from "@mantine/notifications";
import { X } from "lucide-react";
import { error } from "@/platform/native";
import { ChildNode, defaultGame, makePgn, type PgnNodeData, startingPosition } from "chessops/pgn";
import { makeSan } from "chessops/san";
import { z } from "zod";
import type { ArtifactPublication, PathRef } from "@/bindings";
import i18n from "@/i18n";
import { decodeTCN } from "./tcn";

const t = i18n.t.bind(i18n);

const ChessComPerf = z.object({
  last: z.object({
    rating: z.number(),
    date: z.number(),
    rd: z.number().optional(),
  }),
  record: z.object({
    win: z.number(),
    loss: z.number(),
    draw: z.number(),
  }),
});

const ChessComStatsSchema = z.object({
  chess_daily: ChessComPerf.optional(),
  chess_rapid: ChessComPerf.optional(),
  chess_blitz: ChessComPerf.optional(),
  chess_bullet: ChessComPerf.optional(),
});
export type ChessComStats = z.infer<typeof ChessComStatsSchema>;

export async function getChessComAccount(player: string): Promise<ChessComStats | null> {
  const response = await tauri.getPublicChessComJson({ kind: "account", player });
  const data = JSON.parse(response);
  const stats = ChessComStatsSchema.safeParse(data);
  if (!stats.success) {
    error(`Invalid response for Chess.com account: ${stats.error}`);
    notifications.show({
      title: t("ChessCom.FetchAccountFailed"),
      message: t("ChessCom.InvalidResponse", { value: player }),
      color: "danger",
      icon: <X />,
    });
    return null;
  }
  return stats.data;
}

export async function downloadChessCom(
  destination: PathRef,
  player: string,
  timestamp: number | null,
  onTicket: (ticket: string) => void,
): Promise<ArtifactPublication> {
  const result = await withDownloadTicket((ticket) => {
    onTicket(ticket);
    return tauri.downloadChessComGames(
      destination,
      `${player}_chesscom.pgn`,
      player,
      timestamp === null ? null : BigInt(timestamp),
      ticket,
    );
  });
  // Return the whole publication so the caller can report its durability without retrying
  // the committed download.
  return result;
}

const chessComGameSchema = z.object({
  game: z.object({
    moveList: z.string(),
    pgnHeaders: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
});

/** A chess.com game response that cannot be turned into a game. `message` is the log line. */
export class ChessComGameResponseError extends Error {}

/**
 * Fetches one chess.com game and converts it to PGN. No notification, no log: a transport
 * failure rejects with the native error, an unusable response with `ChessComGameResponseError`,
 * and each caller presents the failure itself.
 */
export async function fetchChessComGamePgn(gameType: string, gameId: string): Promise<string> {
  const response = await tauri.getPublicChessComJson({
    kind: "game",
    game_type: gameType,
    game_id: gameId,
  });

  const gameData = chessComGameSchema.safeParse(JSON.parse(response));
  if (!gameData.success) {
    throw new ChessComGameResponseError(`Invalid response for Chess.com game: ${gameData.error}`);
  }

  const moveList = gameData.data.game.moveList;
  const pgnHeaders = gameData.data.game.pgnHeaders;
  const headers = new Map(Object.entries(pgnHeaders).map(([k, v]) => [k, v.toString()]));
  const start = startingPosition(headers);
  if (start.isErr) {
    throw new ChessComGameResponseError(
      `Invalid starting position for Chess.com game: ${start.error}`,
    );
  }
  const game = defaultGame<PgnNodeData>(() => headers);
  const chess = start.value;

  let lastNode = game.moves;
  for (const move of moveList.match(/.{1,2}/g) ?? []) {
    const m = decodeTCN(move);
    if (!chess.isLegal(m)) {
      throw new ChessComGameResponseError(`Illegal move in Chess.com game: ${move}`);
    }
    lastNode.children.push(
      new ChildNode({
        san: makeSan(chess, m),
      }),
    );
    chess.play(m);
    lastNode = lastNode.children[0];
  }

  return makePgn(game);
}

/** The import dialog's entry point: a pasted URL in, a PGN or a shown notification out. */
export async function getChesscomGame(gameURL: string) {
  const regex = /.*\/game\/(?:(live|daily)\/)?(\d+)/;
  const match = gameURL.match(regex);

  if (!match) {
    const eventRegex = /chess.com\/events/;
    if (gameURL.match(eventRegex)) {
      error(`Event URLs are not supported: ${gameURL}`);
      notifications.show({
        title: t("ChessCom.EventUrlUnsupported"),
        message: t("ChessCom.EventUrlUnsupportedMessage"),
        color: "danger",
        icon: <X />,
      });
      return null;
    }
    error(`Unsupported Chess.com URL format: ${gameURL}`);
    notifications.show({
      title: t("ChessCom.UnsupportedUrlFormat"),
      message: t("ChessCom.UnsupportedUrlFormatMessage"),
      color: "danger",
      icon: <X />,
    });
    return null;
  }

  try {
    return await fetchChessComGamePgn(match[1] || "live", match[2]);
  } catch (cause) {
    if (!(cause instanceof ChessComGameResponseError)) throw cause;
    error(cause.message);
    notifications.show({
      title: t("ChessCom.FetchGameFailed"),
      message: t("ChessCom.InvalidResponse", { value: gameURL }),
      color: "danger",
      icon: <X />,
    });
    return null;
  }
}

export function getStats(stats: ChessComStats) {
  const statsArray = [];
  if (stats.chess_bullet) {
    statsArray.push({
      value: stats.chess_bullet.last.rating,
      label: t("TimeControl.Bullet"),
    });
  }
  if (stats.chess_blitz) {
    statsArray.push({
      value: stats.chess_blitz.last.rating,
      label: t("TimeControl.Blitz"),
    });
  }
  if (stats.chess_rapid) {
    statsArray.push({
      value: stats.chess_rapid.last.rating,
      label: t("TimeControl.Rapid"),
    });
  }
  if (stats.chess_daily) {
    statsArray.push({
      value: stats.chess_daily.last.rating,
      label: t("TimeControl.Correspondence"),
    });
  }
  return statsArray;
}
