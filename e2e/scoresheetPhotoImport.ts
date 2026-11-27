import type { Locator, Page } from "@playwright/test";
import type {
    ConnectionSummary,
    ModelList,
    ScoresheetGame,
    Token,
} from "../src/bindings/generated";
import { expect, type MockScenario } from "./fixtures";

// Valid 1x1 JPEG data URL so Chromium decodes and paints it in both thumbnail and Photo panel.
export const PHOTO_DATA_URL =
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

export const scoresheetConnection: ConnectionSummary = {
    handle: "scoresheet-connection",
    kind: "api",
    label: "Local vision",
    address: "http://localhost:11434/v1",
    hasKey: false,
    account: null,
    status: "ready",
};

export const scoresheetModels: ModelList = {
    models: [
        {
            id: "vision-model",
            name: "Vision Model",
            effortLevels: [],
            defaultEffort: null,
            supportsTools: false,
        },
    ],
    truncated: false,
};

export const stubScoresheetGame: ScoresheetGame = {
    headers: {
        white: "Alice",
        black: "Bob",
        event: "Club Open",
        site: "Berlin",
        date: "2026.11.24",
        round: "3",
        result: "1-0",
        whiteElo: "1850",
        blackElo: "1790",
    },
    moves: [
        { san: "e4", unsure: false },
        { san: "e5", unsure: true },
        { san: "Nf3", unsure: false },
        { san: "Nc6", unsure: false },
    ],
    stopped: null,
};

export const stubScoresheetPgnTokens: Token[] = [
    { type: "Header", value: { tag: "Event", value: "Club Open" } },
    { type: "Header", value: { tag: "Site", value: "Berlin" } },
    { type: "Header", value: { tag: "Date", value: "2026.11.24" } },
    { type: "Header", value: { tag: "Round", value: "3" } },
    { type: "Header", value: { tag: "White", value: "Alice" } },
    { type: "Header", value: { tag: "Black", value: "Bob" } },
    { type: "Header", value: { tag: "Result", value: "1-0" } },
    { type: "Header", value: { tag: "WhiteElo", value: "1850" } },
    { type: "Header", value: { tag: "BlackElo", value: "1790" } },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "San", value: "Nf3" },
    { type: "San", value: "Nc6" },
    { type: "Outcome", value: "1-0" },
];

export function scoresheetPhotoCommands(): NonNullable<MockScenario["commands"]> {
    return {
        coach_available: { result: true },
        coach_has_connection: { result: true },
        coach_connections: { result: [scoresheetConnection] },
        coach_models: { result: scoresheetModels },
        scoresheet_pick_photos: {
            result: { photos: [{ dataUrl: PHOTO_DATA_URL }], skipped: 0, failed: 0 },
        },
        scoresheet_read: { result: stubScoresheetGame },
        lex_pgn: { result: stubScoresheetPgnTokens },
    };
}

export async function importFromPhoto(
    page: Page,
    options: {
        expectedPhotoCount?: number;
        onBeforeRead?: (dialog: Locator) => Promise<void>;
    } = {},
): Promise<void> {
    await page.getByRole("button", { name: "Import", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Import Game" });
    await dialog.getByRole("button", { name: "Photo", exact: true }).click();
    await dialog.getByRole("button", { name: "Choose photos or PDF", exact: true }).click();
    await expect(dialog.locator("[data-scoresheet-thumbnails] img")).toHaveCount(
        options.expectedPhotoCount ?? 1,
    );

    // Choose the model through the shared model popover.
    await dialog.getByRole("button", { name: /^AI model: / }).click();
    await page.getByRole("textbox", { name: "Model" }).click();
    await page.getByRole("option", { name: "Vision Model" }).click();
    // Close popover by clicking inside the dialog header.
    await dialog.getByText("Import Game", { exact: true }).click();

    await options.onBeforeRead?.(dialog);

    // Click Read game -> first-use notice -> accept -> opens review tab with Photo panel.
    await dialog.getByRole("button", { name: "Read game" }).click();
    const notice = page.getByRole("dialog", { name: "Before you send photos" });
    await expect(notice).toContainText("Local vision");
    await notice.getByRole("button", { name: "Send photos", exact: true }).click();

    await expect(dialog).toHaveCount(0);
}
