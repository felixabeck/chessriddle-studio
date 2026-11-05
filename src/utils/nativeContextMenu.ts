const textInputTypes = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

export function shouldSuppressNativeContextMenu(target: EventTarget | null): boolean {
    const element =
        target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    const field = element?.closest("input, textarea");
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        return (
            field.disabled ||
            field.readOnly ||
            (field instanceof HTMLInputElement && !textInputTypes.has(field.type))
        );
    }
    for (
        let editable = element?.closest("[contenteditable]");
        editable;
        editable = editable.parentElement?.closest("[contenteditable]")
    ) {
        const value = editable.getAttribute("contenteditable")?.toLowerCase();
        if (value === "false") return true;
        if (value === "" || value === "true" || value === "plaintext-only") return false;
    }
    return true;
}

export function installNativeContextMenuSuppression(): () => void {
    const handler = (event: MouseEvent) => {
        if (shouldSuppressNativeContextMenu(event.target)) event.preventDefault();
    };
    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
}
