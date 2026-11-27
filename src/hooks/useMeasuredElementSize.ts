import { useElementSize } from "@mantine/hooks";
import { useLayoutEffect, useState } from "react";

/** Measures an element's width and height with one ResizeObserver and a pre-paint layout read. */
export function useMeasuredElementSize<T extends HTMLElement = HTMLDivElement>() {
    const { ref, width, height } = useElementSize<T>();
    const [initialSize, setInitialSize] = useState({ width: 0, height: 0 });
    // ResizeObserver publishes on an animation frame. Measure before first paint too,
    // so a paused frame clock cannot leave a desktop tab in the initial zero-size mode.
    useLayoutEffect(() => {
        if (width !== 0 && height !== 0) return;
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        setInitialSize((prev) =>
            prev.width === rect.width && prev.height === rect.height
                ? prev
                : { width: rect.width, height: rect.height },
        );
    }, [ref, width, height]);
    return {
        ref,
        width: width || initialSize.width,
        height: height || initialSize.height,
    };
}
