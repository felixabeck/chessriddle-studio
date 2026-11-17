import type { EngineOption } from "@/bindings";

/**
 * The launch payload for stored engine options. An empty string value has no UCI meaning and the
 * native launch refuses it, so it is dropped (the engine keeps its default); settings saved empty
 * by older builds therefore stop blocking every analysis, report and game with that engine.
 */
export function normalizeEngineOptions(options: readonly EngineOption[]): EngineOption[] {
    return options.flatMap((option): EngineOption[] => {
        if (option.type === "resource") return [option];
        const value = option.value.toString();
        return value === "" ? [] : [{ ...option, value }];
    });
}
