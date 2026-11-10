import equal from "fast-deep-equal";
import { useAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useEngineEditDraft, type EngineEditIntent } from "@/components/engines/engineEditDraft";
import { projectAnalysisSettings, type AnalysisSettings } from "@/state/analysisSettings";
import { tabEngineSettingsFamily } from "@/state/atoms";
import { useOwnerTabId } from "@/state/tabScope";
import type { Engine } from "@/utils/engines";

export function useTabEngineSettings(engine: Engine) {
    const ownerTabId = useOwnerTabId();
    const { displayed, readDisplayed, submit } = useEngineEditDraft(engine);
    const store = useStore();
    const settingsAtom = tabEngineSettingsFamily({
        engineId: engine.id,
        defaultSettings: engine.settings ?? undefined,
        defaultGo: engine.go ?? undefined,
        tab: ownerTabId,
    });
    const [committedSettings, setSettings2] = useAtom(settingsAtom);

    const settings = projectAnalysisSettings(committedSettings, displayed);

    const setSettings = useCallback(
        (fn: (prev: AnalysisSettings) => AnalysisSettings) => {
            const pending = readDisplayed();
            const current = store.get(settingsAtom);
            const previous = projectAnalysisSettings(current, pending);
            const newSettings = fn(previous);
            if (!newSettings.synced) {
                setSettings2(newSettings);
                return;
            }
            setSettings2((current) => ({
                ...current,
                enabled: newSettings.enabled,
                synced: newSettings.synced,
            }));
            const syncing = !previous.synced;
            const changedOptions = newSettings.settings.filter(
                (option) =>
                    syncing ||
                    !equal(
                        option,
                        previous.settings.find((old) => old.name === option.name),
                    ),
            );
            const removedOptions = previous.settings
                .filter((old) => !newSettings.settings.some((option) => option.name === old.name))
                .map((option) => option.name);
            const goChanged = syncing || !equal(newSettings.go, previous.go);
            const intents: EngineEditIntent[] = [];
            if (syncing) intents.push({ kind: "reset", settings: newSettings.settings });
            else {
                for (const option of changedOptions)
                    intents.push({ kind: "option", name: option.name, value: option });
                for (const name of removedOptions)
                    intents.push({ kind: "option", name, value: null });
            }
            if (goChanged) intents.push({ kind: "field", field: "go", value: newSettings.go });
            submit(intents);
        },
        [readDisplayed, settingsAtom, store, setSettings2, submit],
    );

    return { settings, setSettings };
}
