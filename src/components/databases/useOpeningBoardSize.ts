import { useAtom } from "jotai";
import { type CSSProperties, useRef } from "react";
import { useDragResize } from "@/hooks/useDragResize";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import {
    clampOpeningBoardSizeRem,
    DEFAULT_OPENING_BOARD_SIZE_REM,
    maxOpeningBoardSizeRem,
    openingBoardSizeAtom,
} from "@/state/openingBoardSize";
import { roundRem } from "@/state/remPreference";

/** Body width from which board and table share a row; mirrors the `.body` container query. */
const BESIDE_TABLE_MIN_WIDTH_REM = 36;
/** How far one arrow key press resizes the board, in rem. */
const KEY_STEP_REM = 1;

/** The remembered, clamped board size of the Openings tab and its resize handle. */
export function useOpeningBoardSize() {
    const rootFont = useRootFontPx();
    const { ref: rootRef, width } = useElementWidth<HTMLDivElement>();
    const boardRef = useRef<HTMLDivElement | null>(null);
    const [storedRem, setStoredRem] = useAtom(openingBoardSizeAtom);
    const bodyRem = rootFont > 0 ? width / rootFont : 0;
    const maxRem = maxOpeningBoardSizeRem(bodyRem, bodyRem >= BESIDE_TABLE_MIN_WIDTH_REM);
    const normalize = (sizeRem: number) => roundRem(clampOpeningBoardSizeRem(sizeRem, maxRem));
    const resize = useDragResize({
        measuredSizePx: () => {
            const measured = boardRef.current?.getBoundingClientRect().width ?? 0;
            return measured > 0 ? measured : sizeRem * rootFont;
        },
        rootFont,
        normalize,
        growDirection: 1,
        keyStepRem: KEY_STEP_REM,
        setStoredRem,
        defaultRem: DEFAULT_OPENING_BOARD_SIZE_REM,
    });
    const sizeRem = normalize(resize.dragRem ?? storedRem);
    const bodyStyle = { "--opening-board-size": `${sizeRem}rem` } as CSSProperties;
    return {
        rootRef,
        boardRef,
        sizeRem,
        maxRem: Number.isFinite(maxRem) ? roundRem(maxRem) : undefined,
        bodyStyle,
        dragging: resize.dragRem !== null,
        handleProps: resize.handleProps,
    };
}
