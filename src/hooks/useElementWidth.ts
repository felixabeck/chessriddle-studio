import { useElementSize } from "@mantine/hooks";
import { useLayoutEffect, useState } from "react";

export function useElementWidth<T extends HTMLElement = HTMLDivElement>() {
    const { ref, width } = useElementSize<T>();
    const [initialWidth, setInitialWidth] = useState(0);
    // ResizeObserver publishes on an animation frame. Measure before first paint too,
    // so a paused frame clock cannot leave a desktop tab in the initial zero-width mode.
    useLayoutEffect(() => {
        if (width === 0) setInitialWidth(ref.current?.getBoundingClientRect().width ?? 0);
    }, [ref, width]);
    return { ref, width: width || initialWidth };
}
