import type catalogue from "@/translation/en-US.json";

/** Marks a translation key used later through a dynamic t(key) call, so `i18next-cli extract` keeps it (registered in i18next.config.ts `functions`) and tsgo rejects a key missing from the catalogue. */
export function i18nKey<const K extends keyof typeof catalogue.translation>(key: K): K {
    return key;
}
