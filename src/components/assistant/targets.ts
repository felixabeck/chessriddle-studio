import type { createStore } from "jotai";
import type { AssistantFeedbackDraft, AssistantLinkTarget, AssistantSetting } from "@/bindings";
import {
    describeSettings,
    settingCategoryTitle,
    visibleSettingCategories,
    type SettingsBuildFacts,
    type SettingsTranslator,
} from "@/components/settings/settingsDescription";
import type { FeedbackDraft } from "@/components/feedback/openFeedbackContext";
import { requestSettingsNavigation } from "@/state/settingsNavigation";

export type AssistantTargetActions = {
    createNewTab: () => void | Promise<unknown>;
    openLibrary: () => void | Promise<unknown>;
    openEngines: () => void | Promise<unknown>;
    openAccounts: () => void | Promise<unknown>;
    openSettings: () => void | Promise<unknown>;
    openFeedback: (draft?: FeedbackDraft) => void;
    store: ReturnType<typeof createStore>;
};

export type AssistantTargetEntry = {
    readonly id: string;
    readonly label: string;
    readonly open: (
        actions: AssistantTargetActions,
        draft?: AssistantFeedbackDraft | null,
    ) => void | Promise<unknown>;
};

/**
 * Closed registry of every navigation target the Assistant may link to in this build.
 * Labels always come from the app's translations, never from the model.
 */
export function buildAssistantTargets(
    t: SettingsTranslator,
    facts: SettingsBuildFacts,
): ReadonlyMap<string, AssistantTargetEntry> {
    const targets = new Map<string, AssistantTargetEntry>();
    const add = (entry: AssistantTargetEntry) => {
        targets.set(entry.id, entry);
    };

    add({
        id: "page:new-tab",
        label: t("Tab.NewTab"),
        open: (actions) => actions.createNewTab(),
    });
    add({
        id: "page:library",
        label: t("SideBar.Library"),
        open: (actions) => actions.openLibrary(),
    });
    add({
        id: "page:engines",
        label: t("SideBar.Engines"),
        open: (actions) => actions.openEngines(),
    });
    add({
        id: "page:accounts",
        label: t("SideBar.Accounts"),
        open: (actions) => actions.openAccounts(),
    });
    add({
        id: "page:settings",
        label: t("SideBar.Settings"),
        open: (actions) => actions.openSettings(),
    });
    add({
        id: "feedback",
        label: t("Menu.Help.SendFeedback"),
        open: (actions, draft) =>
            actions.openFeedback(
                draft ? { type: draft.feedbackType, message: draft.message } : undefined,
            ),
    });

    for (const category of visibleSettingCategories(facts)) {
        add({
            id: `settings-category:${category}`,
            label: settingCategoryTitle(t, category),
            open: (actions) => {
                requestSettingsNavigation({ kind: "category", category }, actions.store);
                return actions.openSettings();
            },
        });
    }

    for (const setting of describeSettings(t, facts)) {
        if (!setting.shown) continue;
        add({
            id: `setting:${setting.id}`,
            label: setting.title,
            open: (actions) => {
                requestSettingsNavigation(
                    { kind: "setting", settingId: setting.id },
                    actions.store,
                );
                return actions.openSettings();
            },
        });
    }

    return targets;
}

/** Link target list sent in an Assistant turn input. */
export function assistantLinkTargets(
    targets: ReadonlyMap<string, AssistantTargetEntry>,
): AssistantLinkTarget[] {
    return [...targets.values()].map(({ id, label }) => ({ id, label }));
}

/** Settings catalogue sent in an Assistant turn input, in the active interface language. */
export function assistantSettingsPayload(
    t: SettingsTranslator,
    facts: SettingsBuildFacts,
): AssistantSetting[] {
    return describeSettings(t, facts)
        .filter((setting) => setting.shown)
        .map((setting) => ({
            targetId: `setting:${setting.id}`,
            category: settingCategoryTitle(t, setting.category),
            title: setting.title,
            description: setting.description,
        }));
}
