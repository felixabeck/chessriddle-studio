import { atom } from "jotai";
import type { Entry } from "@/components/files/file";

type Selection =
    | { kind: "workspace"; workspaceKey: string; entry: Entry }
    | { kind: "database"; key: string }
    | { kind: "missingCollection"; id: string };

// Plain atoms live for this renderer only. Keep exactly one file's position, by handle identity.
export const librarySelectionAtom = atom<Selection | null>(null);
export const librarySearchAtom = atom("");
export const libraryFilterAtom = atom("");
export const libraryGamePositionAtom = atom<{ key: string; index: number } | null>(null);
