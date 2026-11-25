/**
 * The renderer's Jotai atoms, one module per domain under `./atoms/`. Importers use this barrel;
 * it re-exports each domain's public atoms and keeps the shared factories (`documentPreferences`,
 * `tabAtomFamily`, `tabEngineAtomFamily`, `createEngineOwnerAtom`) private to `./atoms/`.
 */
export { initializeRendererState } from "./atoms/rendererState";
export { disposeTabAtoms, registeredTabAtomFamilies } from "./atoms/tabFamilies";
export { enginesAtom, enginesSchema } from "./atoms/engineOwners";
export * from "./atoms/tabs";
export * from "./atoms/directories";
export * from "./atoms/preferences";
export * from "./atoms/recentFiles";
export * from "./atoms/database";
export * from "./atoms/conversion";
export * from "./atoms/game";
export * from "./atoms/puzzles";
export * from "./atoms/boardPanels";
export * from "./atoms/explorer";
export * from "./atoms/analysis";
export * from "./atoms/practice";
export * from "./atoms/preparation";
