import { useAtomValue } from "jotai";
import { fontSizeAtom } from "@/state/atoms";
import { rootFontPx } from "@/state/paneLayout";

export function useRootFontPx() {
    const fontSize = useAtomValue(fontSizeAtom);
    return rootFontPx(getComputedStyle(document.documentElement).fontSize, fontSize);
}
