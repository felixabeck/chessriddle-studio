import type {
    LibrarySyncFile,
    LibrarySyncSnapshot,
    LibrarySyncState,
} from "../src/bindings/generated";
import {
    assertButtonGlyphsUnclipped,
    assertNothingClipped,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    librarySyncCommands,
    scrollbarFreeScreenshot,
    test,
    waitForFontsSettled,
    waitForTransitionsSettled,
} from "./fixtures";

const ws = filesWorkspaceFixture.workspace;

const syncOffFiles: LibrarySyncFile[] = [
    {
        handle: { id: { id: "sync-file-1" }, kind: "fileWorkspace" },
        name: "Najdorf Repertoire",
        folderLabel: "Openings",
        selected: true,
        status: { kind: "pending" },
    },
    {
        handle: { id: { id: "sync-file-2" }, kind: "fileWorkspace" },
        name: "Mega Archive",
        folderLabel: "",
        selected: true,
        status: { kind: "tooLarge" },
    },
    {
        handle: { id: { id: "sync-db-1" }, kind: "database" },
        name: "Club Games",
        folderLabel: "",
        selected: false,
        status: { kind: "tooManyGames" },
    },
];

const syncOnFiles: LibrarySyncFile[] = [
    {
        handle: { id: { id: "sync-file-1" }, kind: "fileWorkspace" },
        name: "Najdorf Repertoire",
        folderLabel: "Openings",
        selected: true,
        status: { kind: "synced" },
    },
    {
        handle: { id: { id: "sync-file-2" }, kind: "fileWorkspace" },
        name: "Annotated Blitz",
        folderLabel: "",
        selected: true,
        status: { kind: "invalidPgn", gameNumber: 3 },
    },
    {
        handle: { id: { id: "sync-file-3" }, kind: "fileWorkspace" },
        name: "Scratch Notes",
        folderLabel: "",
        selected: false,
        status: { kind: "notSelected" },
    },
];

function snapshot(
    revision: number,
    state: LibrarySyncState,
    files: LibrarySyncFile[] = [],
    available = true,
    active = state.status !== "off",
): LibrarySyncSnapshot {
    return {
        workspace: ws,
        revision,
        available,
        active,
        state,
        files,
    };
}

test("library-sync: action button states, sync-off and sync-on dialog modes, and snapshots", async ({
    page,
    mockScenario,
    emitTauriEvent,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    const baseFilesCommands = filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]]);
    await mockScenario({
        commands: {
            ...baseFilesCommands,
            ...librarySyncCommands({
                snapshot: {
                    result: snapshot(1, { status: "off" }, syncOffFiles, true, false),
                },
                turnOn: {
                    result: snapshot(
                        2,
                        { status: "syncing", done: 1, total: 2 },
                        [
                            { ...syncOnFiles[0] },
                            {
                                handle: syncOffFiles[1].handle,
                                name: "Mega Archive",
                                folderLabel: "",
                                selected: false,
                                status: { kind: "notSelected" },
                            },
                        ],
                        true,
                        true,
                    ),
                },
                setFileSelected: {
                    result: snapshot(4, { status: "synced" }, [syncOnFiles[0]], true, true),
                },
                syncNow: {
                    result: snapshot(5, { status: "synced" }, [syncOnFiles[0]], true, true),
                },
                turnOff: {
                    result: snapshot(6, { status: "off" }, syncOffFiles, true, false),
                },
            }),
        },
    });

    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();

    const actionRow = page.getByRole("group", { name: "Add New" });
    const syncButton = actionRow.getByRole("button", { name: /Sync with ChessRiddle/ });
    await expect(syncButton).toBeVisible();
    await expect(syncButton).toContainText("Off");
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await assertButtonGlyphsUnclipped(syncButton);
    await expect(actionRow).toHaveScreenshot("library-sync-row-off.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    // Open sync-off dialog and capture snapshot.
    await syncButton.click();
    const dialog = page.getByRole("dialog", { name: "Sync with ChessRiddle" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Selected PGN files and game databases")).toBeVisible();
    await expect(
        dialog.getByText("100 files, 5 MB, 40,000 moves and 5,000 games per file"),
    ).toBeVisible();
    await expect(dialog.getByText("Too large", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Club Games/ })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Club Games/ })).not.toBeChecked();
    await expect(dialog.getByText("Too many games", { exact: true })).toBeVisible();
    await assertAccessible();
    await assertNoHorizontalOverflow();
    await waitForTransitionsSettled(page);
    await expect(dialog).toHaveScreenshot("library-sync-dialog-off.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    // Deselect Mega Archive and turn on sync -> transitions to syncing.
    await dialog.getByRole("checkbox", { name: /Mega Archive/ }).click();
    await dialog.getByRole("button", { name: "Turn on sync", exact: true }).click();
    await expect(dialog.getByText("Syncing 1 of 2…")).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(dialog).toHaveCount(0);

    await expect(syncButton).toContainText("1 of 2");
    await waitForTransitionsSettled(page);
    await expect(actionRow).toHaveScreenshot("library-sync-row-syncing.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    // Push event for attention state with per-file errors.
    const attentionSnap = snapshot(3, { status: "attention", count: 1 }, syncOnFiles, true, true);
    const toggledSnap = snapshot(
        4,
        { status: "attention", count: 1 },
        [
            syncOnFiles[0],
            syncOnFiles[1],
            { ...syncOnFiles[2], selected: true, status: { kind: "pending" } },
        ],
        true,
        true,
    );
    const syncedSnap = snapshot(
        5,
        { status: "synced" },
        [
            syncOnFiles[0],
            syncOnFiles[1],
            { ...syncOnFiles[2], selected: true, status: { kind: "synced" } },
        ],
        true,
        true,
    );
    await page.evaluate(
        ({ nextSnap, toggled, synced, base }) => {
            window.__E2E_TAURI__.configure({
                commands: {
                    ...base,
                    library_sync_snapshot: { result: nextSnap },
                    library_sync_set_file_selected: { result: toggled },
                    library_sync_now: { result: synced },
                    library_sync_turn_off: {
                        result: {
                            workspace: nextSnap.workspace,
                            revision: 6,
                            available: true,
                            active: true,
                            state: { status: "removing", done: 1, total: 3 },
                            files: [],
                        },
                    },
                },
            });
        },
        {
            nextSnap: attentionSnap,
            toggled: toggledSnap,
            synced: syncedSnap,
            base: baseFilesCommands,
        },
    );
    await emitTauriEvent({ event: "library-sync-changed", payload: { revision: 3 } });
    await expect(syncButton).toContainText("1 file not synced");
    await waitForTransitionsSettled(page);
    await expect(actionRow).toHaveScreenshot("library-sync-row-attention.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    await syncButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Game 3 could not be read", { exact: true })).toBeVisible();
    await assertAccessible();
    await waitForTransitionsSettled(page);
    await expect(dialog).toHaveScreenshot("library-sync-dialog-on.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    // Toggle a file checkbox and click "Sync now", asserting both native command invocations.
    await dialog.getByRole("checkbox", { name: /Scratch Notes/ }).click();
    await expect(dialog.getByText("Waiting", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Sync now", exact: true }).click();
    await expect(dialog.getByText("All selected files are synced.")).toBeVisible();

    const syncInvocations = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(
                ({ command }) =>
                    command === "library_sync_set_file_selected" || command === "library_sync_now",
            ),
    );
    expect(syncInvocations.map(({ command }) => command)).toEqual([
        "library_sync_set_file_selected",
        "library_sync_now",
    ]);

    // Turn off with remove -> enters removing mode.
    await dialog.getByRole("button", { name: "Turn off sync", exact: true }).click();
    const keepRadio = dialog.getByRole("radio", { name: /Keep files on ChessRiddle/ });
    await expect(keepRadio).toBeChecked();
    await dialog.getByRole("radio", { name: /Remove synced files/ }).click();
    await dialog.getByRole("button", { name: "Turn off sync", exact: true }).click();
    await expect(
        dialog.getByText("Removing synced files from ChessRiddle (1 of 3)…"),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Sync now" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close dialog" }).click();

    // Check failure button states: signInNeeded, then unavailable (hides button).
    await page.evaluate(
        ({ nextSnap, base }) => {
            window.__E2E_TAURI__.configure({
                commands: {
                    ...base,
                    library_sync_snapshot: { result: nextSnap },
                },
            });
        },
        {
            nextSnap: snapshot(7, { status: "signInNeeded" }, [], true, true),
            base: baseFilesCommands,
        },
    );
    await emitTauriEvent({ event: "library-sync-changed", payload: { revision: 7 } });
    await expect(syncButton).toContainText("Sign in again");
    await waitForTransitionsSettled(page);
    await expect(actionRow).toHaveScreenshot("library-sync-row-signin.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    await page.evaluate(
        ({ nextSnap, base }) => {
            window.__E2E_TAURI__.configure({
                commands: {
                    ...base,
                    library_sync_snapshot: { result: nextSnap },
                },
            });
        },
        { nextSnap: snapshot(8, { status: "off" }, [], false, false), base: baseFilesCommands },
    );
    await emitTauriEvent({ event: "library-sync-changed", payload: { revision: 8 } });
    await expect(syncButton).toHaveCount(0);
});

test("library-sync: dialog fits narrow 200% dark viewport without clipping or overflow", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    const longFiles: LibrarySyncFile[] = [
        {
            handle: { id: { id: "narrow-file-1" }, kind: "fileWorkspace" },
            name: "Sicilian_Najdorf_Poisoned_Pawn_Deep_Repertoire_2026",
            folderLabel: "TournamentPreparation/ClassicalOpenings",
            selected: true,
            status: { kind: "synced" },
        },
        {
            handle: { id: { id: "narrow-file-2" }, kind: "fileWorkspace" },
            name: "AnnotatedClubChampionshipEndgamesAndTactics",
            folderLabel: "",
            selected: true,
            status: { kind: "invalidPgn", gameNumber: 12 },
        },
    ];

    await mockScenario({
        commands: filesWorkspaceCommands(
            [[filesWorkspaceFixture.pgnFile]],
            librarySyncCommands({
                snapshot: {
                    result: snapshot(1, { status: "attention", count: 1 }, longFiles, true, true),
                },
            }),
        ),
    });

    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();

    const syncButton = page.getByRole("button", { name: /Sync with ChessRiddle/ });
    await expect(syncButton).toContainText("1 file not synced");
    await waitForFontsSettled(page);
    await assertButtonGlyphsUnclipped(syncButton);
    await assertNoHorizontalOverflow();

    await syncButton.click();
    const dialog = page.getByRole("dialog", { name: "Sync with ChessRiddle" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Sicilian_Najdorf_Poisoned_Pawn/)).toBeVisible();
    await expect(dialog.getByText("Game 12 could not be read", { exact: true })).toBeVisible();
    await assertAccessible();
    await assertNoHorizontalOverflow();
    await assertNothingClipped(dialog, { mode: "reachable" });

    // Open the turn-off keep/remove choice at 320px / 200% dark and verify layout & glyphs.
    await dialog.getByRole("button", { name: "Turn off sync", exact: true }).click();
    await expect(dialog.getByRole("radio", { name: /Keep files on ChessRiddle/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /Remove synced files/ })).toBeVisible();
    await assertButtonGlyphsUnclipped(
        dialog.getByRole("button", { name: "Turn off sync", exact: true }),
    );
    await assertAccessible();
    await assertNoHorizontalOverflow();
    await assertNothingClipped(dialog, { mode: "reachable" });
});
