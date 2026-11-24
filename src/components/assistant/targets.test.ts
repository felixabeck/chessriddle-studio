import { createStore } from "jotai";
import { describe, expect, test, vi } from "vitest";
import {
    describeSettings,
    visibleSettingCategories,
    type SettingsBuildFacts,
} from "@/components/settings/settingsDescription";
import { settingsNavigationRequestAtom } from "@/state/settingsNavigation";
import {
    assistantLinkTargets,
    assistantSettingsPayload,
    buildAssistantTargets,
    type AssistantTargetActions,
} from "./targets";

const t = (key: string) => key;

function createActions(store = createStore()) {
    return {
        createNewTab: vi.fn<() => void>(),
        openLibrary: vi.fn<() => void>(),
        openEngines: vi.fn<() => void>(),
        openAccounts: vi.fn<() => void>(),
        openSettings: vi.fn<() => void>(),
        openFeedback: vi.fn<AssistantTargetActions["openFeedback"]>(),
        store,
    };
}

describe("assistant target registry", () => {
    const facts: SettingsBuildFacts = { platform: "linux", coachEnabled: true };

    test("every target opens what it names", () => {
        const targets = buildAssistantTargets(t, facts);
        const actions = createActions();

        targets.get("page:new-tab")!.open(actions);
        expect(actions.createNewTab).toHaveBeenCalledOnce();

        targets.get("page:library")!.open(actions);
        expect(actions.openLibrary).toHaveBeenCalledOnce();

        targets.get("page:engines")!.open(actions);
        expect(actions.openEngines).toHaveBeenCalledOnce();

        targets.get("page:accounts")!.open(actions);
        expect(actions.openAccounts).toHaveBeenCalledOnce();

        targets.get("page:settings")!.open(actions);
        expect(actions.openSettings).toHaveBeenCalledOnce();

        for (const category of visibleSettingCategories(facts)) {
            actions.openSettings.mockClear();
            const entry = targets.get(`settings-category:${category}`);
            expect(entry).toBeDefined();
            entry!.open(actions);
            expect(actions.store.get(settingsNavigationRequestAtom)?.target).toEqual({
                kind: "category",
                category,
            });
            expect(actions.openSettings).toHaveBeenCalledOnce();
        }

        const shownSettings = describeSettings(t, facts).filter((s) => s.shown);
        for (const setting of shownSettings) {
            actions.openSettings.mockClear();
            const entry = targets.get(`setting:${setting.id}`);
            expect(entry).toBeDefined();
            expect(entry!.label).toBe(setting.title);
            entry!.open(actions);
            expect(actions.store.get(settingsNavigationRequestAtom)?.target).toEqual({
                kind: "setting",
                settingId: setting.id,
            });
            expect(actions.openSettings).toHaveBeenCalledOnce();
        }
    });

    test("feedback target opens prefilled when a draft is provided and empty otherwise", () => {
        const targets = buildAssistantTargets(t, facts);
        const actions = createActions();
        const feedback = targets.get("feedback")!;

        feedback.open(actions, { feedbackType: "bug", message: "Board froze after promotion." });
        expect(actions.openFeedback).toHaveBeenLastCalledWith({
            type: "bug",
            message: "Board froze after promotion.",
        });

        feedback.open(actions, null);
        expect(actions.openFeedback).toHaveBeenLastCalledWith(undefined);

        feedback.open(actions);
        expect(actions.openFeedback).toHaveBeenLastCalledWith(undefined);
    });

    test("omits Coach category and settings when Coach is disabled", () => {
        const disabledFacts: SettingsBuildFacts = { platform: "darwin", coachEnabled: false };
        const targets = buildAssistantTargets(t, disabledFacts);
        expect(targets.has("settings-category:coach")).toBe(false);
        expect(targets.has("setting:coach-engine")).toBe(false);
        expect(targets.has("setting:native-bar")).toBe(false);

        const linkList = assistantLinkTargets(targets);
        expect(linkList.length).toBe(targets.size);

        const settingsPayload = assistantSettingsPayload(t, disabledFacts);
        expect(settingsPayload.every((s) => targets.has(s.targetId))).toBe(true);
    });
});
