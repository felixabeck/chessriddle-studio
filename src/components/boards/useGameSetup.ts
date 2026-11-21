import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import {
    gameInputColorAtom,
    gamePlayer1SettingsAtom,
    gamePlayer2SettingsAtom,
    type GameInputColor,
} from "@/state/atoms";

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

    const sideLabel = (color: GameInputColor) =>
        color === "white"
            ? t("Fen.White")
            : color === "black"
              ? t("Fen.Black")
              : t("Board.Opponent.Random");
    const [player1Color, player2Color] = playerSideColors(inputColor);

    return {
        player1Settings,
        setPlayer1Settings,
        player2Settings,
        setPlayer2Settings,
        player1Side: sideLabel(player1Color),
        player2Side: sideLabel(player2Color),
        cycleColor: () => setInputColor((prev) => nextInputColor(prev)),
        getPlayers: () => assignPlayers(inputColor, player1Settings, player2Settings),
    };
}
