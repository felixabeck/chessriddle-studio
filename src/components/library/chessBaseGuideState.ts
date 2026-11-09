import { atom } from "jotai";

// This renderer owns one guide. Nothing is persisted between sessions.
export const chessBaseGuideAtom = atom<"closed" | "link" | "selected">("closed");
