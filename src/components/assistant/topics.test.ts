import { afterEach, describe, expect, test, vi } from "vitest";
import rustSource from "../../../src-tauri/src/coach/mod.rs?raw";
import {
    visibleSettingCategories,
    type SettingsBuildFacts,
} from "@/components/settings/settingsDescription";
import { supportedLocales, type SupportedLocale } from "@/i18n";
import deDE from "@/translation/de-DE.json";
import enUS from "@/translation/en-US.json";
import { buildAssistantTargets } from "./targets";
import {
    HELP_TOPIC_ORDER,
    extractLabelRefs,
    extractTargetRefs,
    loadHelpTopics,
    loadLocalizedTopicFiles,
    parseHelpTopic,
    resolveHelpTopic,
    setHelpTopicsLoaderForTests,
} from "./topics";
import { rawHelpTopics } from "./topics/bundle";
import { parseTopicFrontmatter } from "./topics/format";

// Mirrors the `MAX_ASSISTANT_*` constants in `src-tauri/src/coach/mod.rs`.
const NATIVE_BOUNDS = {
    MAX_ASSISTANT_TOPICS: 64,
    MAX_ASSISTANT_ID_CHARS: 128,
    MAX_ASSISTANT_TITLE_CHARS: 200,
    MAX_ASSISTANT_SUMMARY_CHARS: 400,
    MAX_ASSISTANT_TOPIC_BODY_BYTES: 32 * 1024,
    MAX_ASSISTANT_TOPICS_TOTAL_BYTES: 512 * 1024,
} as const;

const PLATFORMS = ["darwin", "linux", "win32"] as const;
const PAGE_TARGETS = [
    "page:new-tab",
    "page:library",
    "page:engines",
    "page:accounts",
    "page:settings",
] as const;

const enCatalogue = enUS.translation as Record<string, string>;
const deCatalogue = deDE.translation as Record<string, string>;

const enTranslator = (key: string) => enCatalogue[key] ?? key;
const deTranslator = (key: string) => deCatalogue[key] ?? key;

const REQUIRED_TRANSLATED_LOCALES = supportedLocales.filter(
    (locale): locale is Exclude<SupportedLocale, "en-US" | "en-GB"> =>
        locale !== "en-US" && locale !== "en-GB",
);

const englishTopicSources = import.meta.glob("./topics/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
}) as Record<string, string>;

const localizedTopicSources = import.meta.glob("./topics/*/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
}) as Record<string, string>;

async function topicSourceHash(source: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(source),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16);
}

function sortedMultiset(values: readonly string[]): string[] {
    return [...values].sort();
}

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function charCount(value: string): number {
    return [...value].length;
}

function parseRustUsizeConstant(source: string, name: string): number {
    const match = new RegExp(`const\\s+${name}:\\s*usize\\s*=\\s*([^;]+);`).exec(source);
    if (!match) {
        throw new Error(`Could not find Rust constant ${name} in src-tauri/src/coach/mod.rs`);
    }
    const expr = match[1].replace(/_/g, "").trim();
    const parts = expr.split("*").map((part) => Number(part.trim()));
    if (parts.some((part) => !Number.isInteger(part))) {
        throw new Error(`Unsupported constant expression for ${name}: ${expr}`);
    }
    return parts.reduce((acc, part) => acc * part, 1);
}

describe("help topics", () => {
    test("mirrored native bounds match src-tauri/src/coach/mod.rs", () => {
        for (const [name, expected] of Object.entries(NATIVE_BOUNDS)) {
            expect({ name, value: parseRustUsizeConstant(rustSource, name) }).toEqual({
                name,
                value: expected,
            });
        }
    });

    test("topics have unique kebab-case ids and non-empty fields", () => {
        expect(rawHelpTopics.length).toBeGreaterThan(0);
        const ids = new Set<string>();
        const duplicates: string[] = [];
        for (const topic of rawHelpTopics) {
            expect(topic.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
            if (ids.has(topic.id)) duplicates.push(topic.id);
            ids.add(topic.id);
            expect(topic.title.trim().length).toBeGreaterThan(0);
            expect(topic.summary.trim().length).toBeGreaterThan(0);
            expect(topic.body.trim().length).toBeGreaterThan(0);
        }
        expect(duplicates).toEqual([]);
    });

    test("parseTopicFrontmatter rejects missing delimiters and colon-less frontmatter lines", () => {
        expect(() => parseTopicFrontmatter("No frontmatter here", "broken.md")).toThrow(
            "Help topic broken.md is missing frontmatter delimiters",
        );
        expect(() =>
            parseTopicFrontmatter("---\nid: ok\ninvalid line\n---\nBody", "malformed.md"),
        ).toThrow("Invalid frontmatter line in malformed.md: invalid line");
    });

    test("every topic stays within native bounds", () => {
        expect(rawHelpTopics.length).toBeLessThanOrEqual(NATIVE_BOUNDS.MAX_ASSISTANT_TOPICS);

        for (const translator of [enTranslator, deTranslator]) {
            let totalBytes = 0;
            const violations: string[] = [];
            for (const raw of rawHelpTopics) {
                const resolved = resolveHelpTopic(raw, translator);
                if (charCount(resolved.id) > NATIVE_BOUNDS.MAX_ASSISTANT_ID_CHARS) {
                    violations.push(`${raw.id}: id length`);
                }
                if (charCount(resolved.title) > NATIVE_BOUNDS.MAX_ASSISTANT_TITLE_CHARS) {
                    violations.push(`${raw.id}: title length`);
                }
                if (charCount(resolved.summary) > NATIVE_BOUNDS.MAX_ASSISTANT_SUMMARY_CHARS) {
                    violations.push(`${raw.id}: summary length`);
                }
                if (utf8Bytes(resolved.body) > NATIVE_BOUNDS.MAX_ASSISTANT_TOPIC_BODY_BYTES) {
                    violations.push(`${raw.id}: body bytes`);
                }
                totalBytes +=
                    utf8Bytes(resolved.id) +
                    utf8Bytes(resolved.title) +
                    utf8Bytes(resolved.summary) +
                    utf8Bytes(resolved.body);
            }
            expect(violations).toEqual([]);
            expect(totalBytes).toBeLessThanOrEqual(NATIVE_BOUNDS.MAX_ASSISTANT_TOPICS_TOTAL_BYTES);
        }
    });

    test("every label reference names a key present in en-US.json", () => {
        const problems: string[] = [];
        for (const topic of rawHelpTopics) {
            const combined = `${topic.title}\n${topic.summary}\n${topic.body}`;
            const keys = extractLabelRefs(combined);
            for (const key of keys) {
                if (!Object.prototype.hasOwnProperty.call(enCatalogue, key)) {
                    problems.push(`${topic.id}: missing en-US key ${key}`);
                } else if (enCatalogue[key].trim().length === 0) {
                    problems.push(`${topic.id}: empty en-US key ${key}`);
                }
            }
            // No malformed label placeholders left outside valid {{label:...}} syntax.
            const stripped = combined.replace(/\{\{label:[A-Za-z0-9._-]+\}\}/g, "");
            if (stripped.includes("{{label:")) {
                problems.push(`${topic.id}: malformed label reference`);
            }
        }
        expect(problems).toEqual([]);
    });

    test("every [[target]] exists in the registry on every platform when Coach is available", () => {
        const registries = PLATFORMS.map((platform) => {
            const facts: SettingsBuildFacts = { platform, coachEnabled: true };
            return { platform, targets: buildAssistantTargets(enTranslator, facts) };
        });

        const unknownTargets: string[] = [];
        for (const topic of rawHelpTopics) {
            const targets = extractTargetRefs(topic.body);
            for (const target of targets) {
                for (const { platform, targets: registry } of registries) {
                    if (!registry.has(target)) {
                        unknownTargets.push(
                            `${topic.id}: unknown target [[${target}]] on ${platform}`,
                        );
                    }
                }
            }
        }
        expect(unknownTargets).toEqual([]);
    });

    test("every page target, settings category target, and feedback target is named by at least one topic", () => {
        const referencedTargets = new Set<string>();
        for (const topic of rawHelpTopics) {
            for (const target of extractTargetRefs(topic.body)) {
                referencedTargets.add(target);
            }
        }

        const missing: string[] = [];
        for (const pageTarget of PAGE_TARGETS) {
            if (!referencedTargets.has(pageTarget)) missing.push(`page target ${pageTarget}`);
        }

        for (const category of visibleSettingCategories({ coachEnabled: true })) {
            const categoryTarget = `settings-category:${category}`;
            if (!referencedTargets.has(categoryTarget)) {
                missing.push(`settings category target ${categoryTarget}`);
            }
        }

        if (!referencedTargets.has("feedback")) missing.push("feedback target");
        expect(missing).toEqual([]);
    });

    test("resolving topics with the German catalogue yields German labels and no unresolved references", async () => {
        const resolved = await loadHelpTopics(deTranslator);
        expect(resolved.length).toBe(rawHelpTopics.length);

        const unresolved: string[] = [];
        for (const topic of resolved) {
            const combined = `${topic.title}\n${topic.summary}\n${topic.body}`;
            if (combined.includes("{{label:") || extractLabelRefs(combined).length > 0) {
                unresolved.push(topic.id);
            }
        }
        expect(unresolved).toEqual([]);

        const feedbackTopic = resolved.find((topic) => topic.id === "feedback");
        expect(feedbackTopic).toBeDefined();
        expect(feedbackTopic!.body).toContain(deCatalogue["Menu.Help.SendFeedback"]);
        expect(feedbackTopic!.body).toContain(deCatalogue["Menu.Help.OpenLogs"]);
        expect(feedbackTopic!.body).toContain(deCatalogue["Menu.Help.ClearSavedData"]);
        expect(deCatalogue["Menu.Help.OpenLogs"]).not.toBe(enCatalogue["Menu.Help.OpenLogs"]);
    });

    describe("locale loading and caching", () => {
        afterEach(() => {
            setHelpTopicsLoaderForTests(null);
        });

        test("reading order lists every shipped topic id exactly once", () => {
            expect(new Set(HELP_TOPIC_ORDER).size).toBe(HELP_TOPIC_ORDER.length);
            expect([...HELP_TOPIC_ORDER].sort()).toEqual(
                rawHelpTopics.map((topic) => topic.id).sort(),
            );
        });

        test("en-GB and en-US resolve to the English bundle", async () => {
            const [usTopics, gbTopics] = await Promise.all([
                loadHelpTopics(enTranslator, "en-US"),
                loadHelpTopics(enTranslator, "en-GB"),
            ]);
            expect(usTopics.length).toBe(rawHelpTopics.length);
            expect(gbTopics).toEqual(usTopics);
            expect(usTopics.map((topic) => topic.id)).toEqual([...HELP_TOPIC_ORDER]);
        });

        test("rejected locale load rejects without English fallback, evicts cache, and retries", async () => {
            let calls = 0;
            const loader = vi.fn(async (locale: string) => {
                calls += 1;
                if (calls === 1) {
                    throw new Error(`load failed for ${locale}`);
                }
                return [
                    {
                        id: "settings",
                        title: `Title (${locale})`,
                        summary: "Summary",
                        body: "Body",
                    },
                ];
            });
            setHelpTopicsLoaderForTests(loader);

            await expect(loadHelpTopics(deTranslator, "de-DE")).rejects.toThrow(
                "load failed for de-DE",
            );
            expect(loader).toHaveBeenCalledTimes(1);
            expect(loader).toHaveBeenCalledWith("de-DE");

            const retried = await loadHelpTopics(deTranslator, "de-DE");
            expect(loader).toHaveBeenCalledTimes(2);
            expect(retried).toEqual([
                {
                    id: "settings",
                    title: "Title (de-DE)",
                    summary: "Summary",
                    body: "Body",
                },
            ]);
        });

        test("per-locale caches are independent", async () => {
            const loader = vi.fn(async (locale: string) => {
                if (locale === "de-DE") {
                    throw new Error("de-DE unavailable");
                }
                return [
                    {
                        id: "feedback",
                        title: `Title ${locale}`,
                        summary: "Summary",
                        body: "Body",
                    },
                ];
            });
            setHelpTopicsLoaderForTests(loader);

            const frFirst = await loadHelpTopics(enTranslator, "fr-FR");
            const frSecond = await loadHelpTopics(enTranslator, "fr-FR");
            expect(frFirst).toEqual(frSecond);
            expect(loader).toHaveBeenCalledTimes(1);

            await expect(loadHelpTopics(deTranslator, "de-DE")).rejects.toThrow(
                "de-DE unavailable",
            );
            expect(loader).toHaveBeenCalledTimes(2);

            const esTopics = await loadHelpTopics(enTranslator, "es-ES");
            expect(esTopics[0]?.title).toBe("Title es-ES");
            expect(loader).toHaveBeenCalledTimes(3);
            expect(loader.mock.calls.map(([locale]) => locale)).toEqual([
                "fr-FR",
                "de-DE",
                "es-ES",
            ]);
        });

        test("loadLocalizedTopicFiles rejects on empty or missing locale map and filters and orders matching files", async () => {
            await expect(loadLocalizedTopicFiles({}, "de-DE")).rejects.toThrow(
                "Help topics are not available for locale de-DE",
            );

            await expect(
                loadLocalizedTopicFiles(
                    {
                        "./topics/fr-FR/feedback.md": async () =>
                            "---\nid: feedback\ntitle: Retour\nsummary: Sum\n---\nBody",
                    },
                    "de-DE",
                ),
            ).rejects.toThrow("Help topics are not available for locale de-DE");

            const topics = await loadLocalizedTopicFiles(
                {
                    "./topics/de-DE/feedback.md": async () =>
                        "---\nid: feedback\ntitle: Feedback DE\nsummary: Sum DE\n---\nBody DE",
                    "./topics/de-DE/tabs-and-new-tab.md": async () =>
                        "---\nid: tabs-and-new-tab\ntitle: Tabs DE\nsummary: Sum Tabs\n---\nBody Tabs",
                    "./topics/fr-FR/settings.md": async () => {
                        throw new Error("other locale should not be loaded");
                    },
                },
                "de-DE",
            );

            expect(topics.map((topic) => topic.id)).toEqual(["tabs-and-new-tab", "feedback"]);
            expect(topics.map((topic) => topic.title)).toEqual(["Tabs DE", "Feedback DE"]);
        });

        test("real un-stubbed loader returns German topic bodies and German labels for de-DE", async () => {
            setHelpTopicsLoaderForTests(null);
            const deTopics = await loadHelpTopics(deTranslator, "de-DE");
            const enTopics = await loadHelpTopics(enTranslator, "en-US");

            expect(deTopics.length).toBe(rawHelpTopics.length);
            expect(deTopics.map((topic) => topic.id)).toEqual([...HELP_TOPIC_ORDER]);

            for (const deTopic of deTopics) {
                const enTopic = enTopics.find((candidate) => candidate.id === deTopic.id);
                expect(enTopic).toBeDefined();
                expect(deTopic.title).not.toBe(enTopic!.title);
                expect(deTopic.summary).not.toBe(enTopic!.summary);
                expect(deTopic.body).not.toBe(enTopic!.body);
                expect(deTopic.body).not.toContain("{{label:");
                expect(
                    extractLabelRefs(`${deTopic.title}\n${deTopic.summary}\n${deTopic.body}`),
                ).toEqual([]);
            }

            const feedbackTopic = deTopics.find((topic) => topic.id === "feedback");
            expect(feedbackTopic).toBeDefined();
            expect(feedbackTopic!.title).toBe(
                "Feedback, Protokolle, gespeicherte Daten löschen und Updates",
            );
            expect(feedbackTopic!.body).toContain("Fehler zu melden");
            expect(feedbackTopic!.body).toContain(deCatalogue["Menu.Help.SendFeedback"]);
            expect(feedbackTopic!.body).toContain(deCatalogue["Menu.Help.OpenLogs"]);
            expect(feedbackTopic!.body).toContain(deCatalogue["Menu.Help.ClearSavedData"]);
            expect(feedbackTopic!.body).not.toContain("report a bug");

            const aiTopic = deTopics.find((topic) => topic.id === "ai-connections");
            expect(aiTopic).toBeDefined();
            expect(aiTopic!.body).toContain("KI-Verbindungen versorgen sowohl den Coach");
            expect(aiTopic!.body).toContain(deCatalogue["Settings.AI"]);
            expect(aiTopic!.body).toContain(deCatalogue["SideBar.Engines"]);
        });

        test("real un-stubbed loader loads every required locale in HELP_TOPIC_ORDER with non-empty translated content", async () => {
            setHelpTopicsLoaderForTests(null);
            const enTopics = await loadHelpTopics(enTranslator, "en-US");
            const enById = new Map(enTopics.map((topic) => [topic.id, topic]));

            for (const locale of REQUIRED_TRANSLATED_LOCALES) {
                const topics = await loadHelpTopics(enTranslator, locale);
                expect(topics.map((topic) => topic.id)).toEqual([...HELP_TOPIC_ORDER]);
                for (const topic of topics) {
                    const enTopic = enById.get(topic.id);
                    expect(enTopic).toBeDefined();
                    expect(topic.summary.trim().length).toBeGreaterThan(0);
                    expect(topic.body.trim().length).toBeGreaterThan(0);
                    expect({ locale, id: topic.id, body: topic.body }).not.toEqual({
                        locale,
                        id: topic.id,
                        body: enTopic!.body,
                    });
                    expect({ locale, id: topic.id, title: topic.title }).not.toEqual({
                        locale,
                        id: topic.id,
                        title: enTopic!.title,
                    });
                    expect({ locale, id: topic.id, summary: topic.summary }).not.toEqual({
                        locale,
                        id: topic.id,
                        summary: enTopic!.summary,
                    });
                }
            }
        });
    });

    describe("localized topic translations", () => {
        test("every required non-English locale translates every English topic with matching refs and source hash", async () => {
            expect(REQUIRED_TRANSLATED_LOCALES.length).toBe(supportedLocales.length - 2);
            const requiredLocaleSet = new Set<string>(REQUIRED_TRANSLATED_LOCALES);
            const englishEntries = await Promise.all(
                Object.entries(englishTopicSources).map(async ([filePath, raw]) => {
                    const filename = filePath.replace("./topics/", "");
                    const parsed = parseHelpTopic(raw, filePath);
                    const combined = `${parsed.title}\n${parsed.summary}\n${parsed.body}`;
                    return {
                        filename,
                        parsed,
                        sourceHash: await topicSourceHash(raw),
                        labels: sortedMultiset(extractLabelRefs(combined)),
                        targets: sortedMultiset(extractTargetRefs(combined)),
                    };
                }),
            );
            const englishByFilename = new Map(
                englishEntries.map((entry) => [entry.filename, entry]),
            );
            const problems: string[] = [];

            for (const locale of REQUIRED_TRANSLATED_LOCALES) {
                for (const english of englishEntries) {
                    const translatedPath = `./topics/${locale}/${english.filename}`;
                    const translatedRaw = localizedTopicSources[translatedPath];
                    if (translatedRaw === undefined) {
                        problems.push(`${translatedPath}: missing translation file`);
                        continue;
                    }
                    const parsed = parseHelpTopic(translatedRaw, translatedPath);
                    if (parsed.id !== english.parsed.id) {
                        problems.push(
                            `${translatedPath}: id ${parsed.id} does not match ${english.parsed.id}`,
                        );
                    }
                    const sourceHash = parseTopicFrontmatter(
                        translatedRaw,
                        translatedPath,
                    ).fields.get("source");
                    if (sourceHash !== english.sourceHash) {
                        problems.push(
                            `${translatedPath}: source hash ${sourceHash ?? "<missing>"} does not match ${english.sourceHash}`,
                        );
                    }
                    const combined = `${parsed.title}\n${parsed.summary}\n${parsed.body}`;
                    const labels = sortedMultiset(extractLabelRefs(combined));
                    const targets = sortedMultiset(extractTargetRefs(combined));
                    if (JSON.stringify(labels) !== JSON.stringify(english.labels)) {
                        problems.push(`${translatedPath}: label reference multiset mismatch`);
                    }
                    if (JSON.stringify(targets) !== JSON.stringify(english.targets)) {
                        problems.push(`${translatedPath}: target reference multiset mismatch`);
                    }
                }
            }

            for (const filePath of Object.keys(localizedTopicSources)) {
                const match = /^\.\/topics\/([^/]+)\/([^/]+\.md)$/.exec(filePath);
                if (!match) {
                    problems.push(`${filePath}: unexpected localized topic path`);
                    continue;
                }
                const [, locale, filename] = match;
                if (!requiredLocaleSet.has(locale)) {
                    problems.push(`${filePath}: unexpected translation locale ${locale}`);
                }
                if (!englishByFilename.has(filename)) {
                    problems.push(`${filePath}: translation exists without an English original`);
                }
            }

            expect(problems).toEqual([]);
        });
    });
});
