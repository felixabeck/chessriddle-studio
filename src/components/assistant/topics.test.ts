import { describe, expect, test } from "vitest";
import rustSource from "../../../src-tauri/src/coach/mod.rs?raw";
import {
    visibleSettingCategories,
    type SettingsBuildFacts,
} from "@/components/settings/settingsDescription";
import deDE from "@/translation/de-DE.json";
import enUS from "@/translation/en-US.json";
import { buildAssistantTargets } from "./targets";
import { extractLabelRefs, extractTargetRefs, loadHelpTopics, resolveHelpTopic } from "./topics";
import { rawHelpTopics } from "./topics/bundle";

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
});
