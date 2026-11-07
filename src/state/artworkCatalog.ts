import { z } from "zod";

export const DEFAULT_PIECE_SET = "staunty";
export const DEFAULT_BOARD_IMAGE = "chessriddle.svg";

export const PIECE_SETS = [
    { label: "Alpha", value: "alpha" },
    { label: "Anarcandy", value: "anarcandy" },
    { label: "California", value: "california" },
    { label: "Cardinal", value: "cardinal" },
    { label: "Cburnett", value: "cburnett" },
    { label: "Chess7", value: "chess7" },
    { label: "Chessnut", value: "chessnut" },
    { label: "Companion", value: "companion" },
    { label: "Disguised", value: "disguised" },
    { label: "Dubrovny", value: "dubrovny" },
    { label: "Fantasy", value: "fantasy" },
    { label: "Fresca", value: "fresca" },
    { label: "Gioco", value: "gioco" },
    { label: "Governor", value: "governor" },
    { label: "Horsey", value: "horsey" },
    { label: "ICpieces", value: "icpieces" },
    { label: "Kosal", value: "kosal" },
    { label: "Leipzig", value: "leipzig" },
    { label: "Letter", value: "letter" },
    { label: "Libra", value: "libra" },
    { label: "Maestro", value: "maestro" },
    { label: "Merida", value: "merida" },
    { label: "Pirouetti", value: "pirouetti" },
    { label: "Pixel", value: "pixel" },
    { label: "Reillycraig", value: "reillycraig" },
    { label: "Riohacha", value: "riohacha" },
    { label: "Shapes", value: "shapes" },
    { label: "Spatial", value: "spatial" },
    { label: "Staunty", value: "staunty" },
    { label: "Tatiana", value: "tatiana" },
] as const;

export const BOARD_IMAGES = [
    "chessriddle.svg",
    "blue.png",
    "blue2.jpg",
    "blue3.jpg",
    "blue-marble.jpg",
    "canvas2.jpg",
    "wood.jpg",
    "wood2.jpg",
    "wood3.jpg",
    "wood4.jpg",
    "maple.jpg",
    "maple2.jpg",
    "leather.jpg",
    "green.png",
    "brown.png",
    "pink-pyramid.png",
    "marble.jpg",
    "green-plastic.png",
    "grey.jpg",
    "metal.jpg",
    "olive.jpg",
    "newspaper.svg",
    "purple.png",
    "purple-diag.png",
    "ic.png",
    "horsey.jpg",
    "gray.svg",
] as const;

type PieceSetValue = (typeof PIECE_SETS)[number]["value"];

export const PIECE_SET_VALUES = [
    PIECE_SETS[0].value,
    ...PIECE_SETS.slice(1).map((item) => item.value),
] as [PieceSetValue, ...PieceSetValue[]];

export const pieceSetSchema = z.enum(PIECE_SET_VALUES);
export const boardImageSchema = z.enum(BOARD_IMAGES);
