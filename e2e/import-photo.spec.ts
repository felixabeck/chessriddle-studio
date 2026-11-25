import type {
    ConnectionSummary,
    ModelList,
    ScoresheetGame,
    Token,
} from "../src/bindings/generated";
import { expect, test, waitForTransitionsSettled, type MockScenario } from "./fixtures";

// Valid 1x1 JPEG data URL so Chromium decodes and paints it in both thumbnail and Photo panel.
const PHOTO_DATA_URL =
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

const connection: ConnectionSummary = {
    handle: "scoresheet-connection",
    kind: "api",
    label: "Local vision",
    address: "http://localhost:11434/v1",
    hasKey: false,
    account: null,
    status: "ready",
};

const models: ModelList = {
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

const stubGame: ScoresheetGame = {
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

const stubPgnTokens: Token[] = [
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

test("import from photo shows hint without a connection", async ({ page, mockScenario }) => {
    await mockScenario({
        commands: {
            coach_available: { result: true },
            coach_has_connection: { result: false },
            coach_connections: { result: [] },
        },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import Game" });
    await dialog.getByText("From photo", { exact: true }).click();
    await expect(
        dialog.getByText("Reading a scoresheet photo requires an AI connection."),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Open AI settings" })).toBeVisible();
    await waitForTransitionsSettled(page);
    await expect(dialog).toHaveScreenshot("import-photo-no-connection.png");
});

test("import from photo reads stubbed game and opens review tab with Photo panel and marked move", async ({
    page,
    mockScenario,
}) => {
    const commands: NonNullable<MockScenario["commands"]> = {
        coach_available: { result: true },
        coach_has_connection: { result: true },
        coach_connections: { result: [connection] },
        coach_models: { result: models },
        scoresheet_pick_photos: {
            result: {
                photos: [{ dataUrl: PHOTO_DATA_URL }],
                skipped: 0,
                failed: 0,
            },
        },
        scoresheet_read: { result: stubGame },
        lex_pgn: { result: stubPgnTokens },
    };
    await mockScenario({ commands });
    await page.goto("/");
    await page.getByRole("button", { name: "Import", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Import Game" });
    await dialog.getByText("From photo", { exact: true }).click();
    await dialog.getByRole("button", { name: "Choose photos" }).click();
    await expect(dialog.locator("[data-scoresheet-thumbnails] img")).toHaveCount(1);

    // Choose the model through the shared model popover.
    await dialog.getByRole("button", { name: /^AI model: / }).click();
    await page.getByRole("textbox", { name: "Model" }).click();
    await page.getByRole("option", { name: "Vision Model" }).click();
    // Close popover by clicking inside the dialog header.
    await dialog.getByText("Import Game", { exact: true }).click();

    await waitForTransitionsSettled(page);
    await expect(dialog).toHaveScreenshot("import-photo-with-connection.png");

    // Click Read game -> first-use notice -> accept -> opens review tab with Photo panel.
    await dialog.getByRole("button", { name: "Read game" }).click();
    const notice = page.getByRole("dialog", { name: "Before you send photos" });
    await expect(notice).toContainText("Local vision");
    await notice.getByRole("button", { name: "Send photos", exact: true }).click();

    // Dialog closes and the new analysis tab opens with the Photo panel active and `e5` marked unsure.
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Photo", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
    );
    await expect(page.getByText("1 move to check")).toBeVisible();
    await expect(page.locator("[data-notation-unsure]")).toHaveCount(1);
    await waitForTransitionsSettled(page);
    await expect(page).toHaveScreenshot("import-photo-review-tab.png");
});
