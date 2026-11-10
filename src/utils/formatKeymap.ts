import { platform } from "@/platform/native";

const mapToOs = (key: string): string => {
    const arrows: Record<string, string> = {
        arrowleft: "←",
        arrowright: "→",
        arrowup: "↑",
        arrowdown: "↓",
    };
    if (arrows[key.toLowerCase()]) return arrows[key.toLowerCase()];
    const isMacos = platform() === "macos";

    if (!isMacos) {
        return key === "meta" ? "ctrl" : key;
    }

    if (key === "meta" || key === "cmd") {
        return "⌘";
    } else if (key === "ctrl") {
        return "⌃";
    } else if (key === "shift") {
        return "⇧";
    } else if (key === "alt") {
        return "⌥";
    }

    return key;
};

export function formatKeymap(keys: string): string {
    return keys.split("+").map(mapToOs).join("+");
}
