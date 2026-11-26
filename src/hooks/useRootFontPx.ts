import { useAtomValue } from "jotai";
import { useSyncExternalStore } from "react";
import { fontSizeAtom } from "@/state/atoms";

export function rootFontPx(computedFontSize: string, fontScale: number): number {
    return Number.parseFloat(computedFontSize) || (16 * fontScale) / 100;
}

function subscribeRootFontStyle(onStoreChange: () => void): () => void {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
        return () => undefined;
    }
    const observer = new MutationObserver(onStoreChange);
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style"],
    });
    return () => observer.disconnect();
}

function readDocumentFontSize(): string {
    if (typeof document === "undefined" || typeof getComputedStyle === "undefined") {
        return "";
    }
    return getComputedStyle(document.documentElement).fontSize;
}

export function useRootFontPx(): number {
    const fontSize = useAtomValue(fontSizeAtom);
    const computedFontSize = useSyncExternalStore(
        subscribeRootFontStyle,
        readDocumentFontSize,
        () => "",
    );
    return rootFontPx(computedFontSize, fontSize);
}
