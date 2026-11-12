import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useRef, useState } from "react";
import { writeClipboardText } from "@/utils/clipboard";

export function useClipboardCopy(failureMessage: string, timeout = 2000) {
    const [copied, setCopied] = useState(false);
    const mounted = useRef(false);
    const attempt = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            attempt.current += 1;
            clearTimeout(timer.current);
        };
    }, []);

    const copy = useCallback(
        async (text: string): Promise<void> => {
            if (!mounted.current) return;
            const identity = ++attempt.current;
            clearTimeout(timer.current);
            setCopied(false);
            try {
                await writeClipboardText(text);
                if (!mounted.current || attempt.current !== identity) return;
                setCopied(true);
                timer.current = setTimeout(() => {
                    if (mounted.current && attempt.current === identity) setCopied(false);
                }, timeout);
            } catch {
                if (!mounted.current || attempt.current !== identity) return;
                setCopied(false);
                notifications.show({ message: failureMessage, color: "danger" });
            }
        },
        [failureMessage, timeout],
    );

    return { copied, copy };
}
