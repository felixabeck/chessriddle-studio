/** Play-against-engine settings and per-tab game state. */
import type { SetStateAction } from "react";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod";
import type { GameResult, OpeningBookHandle } from "@/bindings";
import { pathRefSchema } from "../../utils/pathCapabilities";
import { createPreferenceStorage, createZodStorage, initializeBeforeUse } from "../utils";
import { openingBookMaxPlySchema } from "../preferenceSchemas";
import {
    defaultPlayerSettings,
    opponentSettingsSchema,
    type OpponentSettings,
} from "../opponentSettings";
import { createEngineOwnerAtom } from "./engineOwners";
import { initializeRendererState } from "./rendererState";
import { tabAtomFamily } from "./tabFamilies";

export type GameInputColor = "white" | "random" | "black";

export const gameInputColorAtom = atomWithStorage<GameInputColor>(
    "game-input-color",
    "white",
    createZodStorage(z.enum(["white", "random", "black"]), localStorage),
);

function createPlayerSettingsAtom(key: "game-player1-settings" | "game-player2-settings") {
    return createEngineOwnerAtom(
        key,
        opponentSettingsSchema,
        defaultPlayerSettings,
        defaultPlayerSettings,
        (current, update: SetStateAction<OpponentSettings>) =>
            typeof update === "function" ? update(current) : update,
    );
}

export const gamePlayer1SettingsAtom = createPlayerSettingsAtom("game-player1-settings");
export const gamePlayer2SettingsAtom = createPlayerSettingsAtom("game-player2-settings");

export const gameSameTimeControlAtom = atomWithStorage<boolean>(
    "game-same-time-control",
    true,
    createPreferenceStorage(true),
);

export const gameOpeningBookHandleAtom = initializeBeforeUse(
    atomWithStorage<OpeningBookHandle | null>(
        "game-opening-book-handle",
        null,
        createZodStorage(
            z.object({ id: pathRefSchema, kind: z.literal("openingBook") }).nullable(),
            localStorage,
        ),
    ),
    initializeRendererState,
);

export const gameOpeningBookEnabledAtom = atomWithStorage<boolean>(
    "game-opening-book-enabled",
    false,
    createPreferenceStorage(false),
);

export const gameOpeningBookMaxPlyAtom = atomWithStorage<number>(
    "game-opening-book-max-ply",
    40,
    createZodStorage(openingBookMaxPlySchema, localStorage),
);

type GameState = "settingUp" | "playing" | "gameOver";
export const gameStateFamily = tabAtomFamily((_tab: string) => atom<GameState>("settingUp"));

/**
 * Per play tab, in memory only, disposed with the tab. null: an ordinary play tab, colour comes
 * from the global preference. { chosen: null }: opened by Play from here, player 1's colour is
 * derived from the side to move by `seededInputColor` (player 1 takes it unless player 1 is an
 * engine and player 2 is human). { chosen: colour }: the user cycled the colour in this tab.
 */
export type PlayFromHereColor = { chosen: GameInputColor | null };
export const playFromHereColorFamily = tabAtomFamily((_tab: string) =>
    atom<PlayFromHereColor | null>(null),
);

export const playersFamily = tabAtomFamily((_tab: string) =>
    atom<{
        white: OpponentSettings;
        black: OpponentSettings;
    }>({ white: {} as OpponentSettings, black: {} as OpponentSettings }),
);

export const gameIdFamily = tabAtomFamily((_tab: string) => atom<string | null>(null));
export const gameSessionFamily = tabAtomFamily((_tab: string) => atom<bigint | null>(null));
export const pendingGameStartFamily = tabAtomFamily((_tab: string) =>
    atom<Promise<void> | null>(null),
);

/** Retained only while the owner tab exists, including inactive-tab unmounts. */
export const gameInterruptionFamily = tabAtomFamily((_tab: string) =>
    atom<
        | (Extract<GameResult, { type: "interrupted" }> & {
              engineColor: "white" | "black" | null;
          })
        | null
    >(null),
);
