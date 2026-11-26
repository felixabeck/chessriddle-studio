import { useEffect, useState, type RefObject } from "react";

/** How close to the window's top edge the pointer must come to bring a hidden header back. */
export const HEADER_REVEAL_EDGE_PX = 6;

/**
 * While `active` (focus mode), the hidden header shows again when the pointer reaches the top
 * edge and hides once the pointer moves below it, unless a menu or popover opened from the header
 * is still open (an element in it carries `aria-expanded="true"`).
 *
 * One document listener is used rather than a hover strip, because events from the window resize
 * handles along the top edge bubble to it too, so resizing keeps working. The listener exists only
 * while `active`; the cleanup removes it and drops the reveal on exit and unmount.
 */
export function useHeaderReveal(
    active: boolean,
    headerRef: RefObject<HTMLElement | null>,
): boolean {
    const [revealed, setRevealed] = useState(false);

    useEffect(() => {
        if (!active) return;
        const onPointerMove = (event: PointerEvent) => {
            if (event.clientY < HEADER_REVEAL_EDGE_PX) {
                setRevealed(true);
                return;
            }
            const header = headerRef.current;
            if (!header) return;
            // The layout height, not the on-screen box: while the header slides in, its box is still
            // partly above the window, and a pointer already inside it must not hide it again.
            if (event.clientY <= header.offsetHeight) return;
            if (header.querySelector('[aria-expanded="true"]')) return;
            setRevealed(false);
        };
        document.addEventListener("pointermove", onPointerMove);
        return () => {
            document.removeEventListener("pointermove", onPointerMove);
            setRevealed(false);
        };
    }, [active, headerRef]);

    return active && revealed;
}
