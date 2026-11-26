import { atom } from "jotai";

/**
 * Focus mode hides the navigation row (the app header). Deliberately not persisted: every start
 * shows the header, so nobody opens the app without its tabs and window controls.
 */
export const focusModeAtom = atom(false);
