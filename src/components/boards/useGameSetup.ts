import { useAtom } from "jotai";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
    gameInputColorAtom,
    gamePlayer1SettingsAtom,
    gamePlayer2SettingsAtom,
    playFromHereColorFamily,
    type GameInputColor,
} from "@/state/atoms";
import type { OpponentSettings } from "@/state/opponentSettings";
import { useTabAtom } from "@/state/tabScope";
import { positionFromFen } from "@/utils/chessops";
import { getMainlineEndNode, type TreeNode } from "@/utils/treeReducer";

/** The colour control cycles white → black → random → white for player 1. */
export function nextInputColor(color: GameInputColor): GameInputColor {
    const cycle = { white: "black", black: "random", random: "white" } as const;
    return cycle[color];
}

/** Player 2 always takes the colour player 1 does not; a random draw is random for both. */
export function playerSideColors(color: GameInputColor): [GameInputColor, GameInputColor] {
    const opposite = { white: "black", black: "white", random: "random" } as const;
    return [color, opposite[color]];
}

/**
 * Colour for player 1 when a play tab is seeded from a position: player 1 takes the side to
 * move unless player 1 is an engine and player 2 is human.
 */
export function seededInputColor(
    sideToMove: "white" | "black",
    player1Type: OpponentSettings["type"],
    player2Type: OpponentSettings["type"],
): "white" | "black" {
    const opposite = sideToMove === "white" ? "black" : "white";
    if (player1Type === "engine" && player2Type === "human") return opposite;
    return sideToMove;
}

/** The side to move encoded in `fen`, or white when the FEN does not parse. */
export function sideToMoveFromFen(fen: string): "white" | "black" {
    const [position] = positionFromFen(fen);
    return position?.turn ?? "white";
}

function mainlineSideToMove(root: TreeNode): "white" | "black" {
    return sideToMoveFromFen(getMainlineEndNode(root).fen);
}

export function assignPlayers<T>(
    color: GameInputColor,
    player1: T,
    player2: T,
    random: () => number = Math.random,
): { white: T; black: T } {
    const isPlayer1White = color === "random" ? random() > 0.5 : color === "white";
    return {
        white: isPlayer1White ? player1 : player2,
        black: isPlayer1White ? player2 : player1,
    };
}

/**
 * The setup half of a game tab: which colour player 1 takes, both players' settings, the side
 * headings shown over each opponent form, and the colour assignment drawn at start.
 */
export function useGameSetup() {
    const { t } = useTranslation();
    const [inputColor, setInputColor] = useAtom(gameInputColorAtom);
    const [player1Settings, setPlayer1Settings] = useAtom(gamePlayer1SettingsAtom);
    const [player2Settings, setPlayer2Settings] = useAtom(gamePlayer2SettingsAtom);
    const [playFromHereColor, setPlayFromHereColor] = useAtom(useTabAtom(playFromHereColorFamily));
    const treeStore = useContext(TreeStateContext)!;
    const root = useStore(treeStore, (s) => s.root);

    const sideLabel = (color: GameInputColor) =>
        color === "white"
            ? t("Fen.White")
            : color === "black"
              ? t("Fen.Black")
              : t("Board.Opponent.Random");
    const player1InputColor: GameInputColor = playFromHereColor
        ? (playFromHereColor.chosen ??
          seededInputColor(mainlineSideToMove(root), player1Settings.type, player2Settings.type))
        : inputColor;
    const [player1Color, player2Color] = playerSideColors(player1InputColor);

    return {
        player1Settings,
        setPlayer1Settings,
        player2Settings,
        setPlayer2Settings,
        player1Side: sideLabel(player1Color),
        player2Side: sideLabel(player2Color),
        cycleColor: () => {
            if (playFromHereColor) {
                setPlayFromHereColor({ chosen: nextInputColor(player1InputColor) });
                return;
            }
            setInputColor((prev) => nextInputColor(prev));
        },
        getPlayers: () => assignPlayers(player1InputColor, player1Settings, player2Settings),
    };
}
