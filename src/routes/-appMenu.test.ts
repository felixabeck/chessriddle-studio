import { afterEach, expect, test } from "vitest";
import {
    assembleNativeMenuResources,
    buildAppMenuTree,
    buildInAppMenuItems,
    installAppMenuSurface,
    menuWindowPlatform,
    openPageFromMenu,
    openPgnFromMenu,
    renderResizeHandles,
    resetInstallChainForTests,
    runNativeMenuAction,
    bindAppMenuCallbacks,
    wantNativeDecorations,
    wantRealMenu,
    type AppMenuCallbacks,
    type MenuAction,
    type MenuGroup,
    type MenuHandle,
    type NativeMenuResource,
} from "./-appMenu";

afterEach(() => {
    resetInstallChainForTests();
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function idsOf(groups: MenuGroup[], label: string): string[] {
    const group = groups.find((item) => item.label === label);
    if (!group) return [];
    return group.options.flatMap((option) =>
        "kind" in option && option.kind === "separator" ? [] : option.id ? [option.id] : [],
    );
}

function option(groups: MenuGroup[], groupLabel: string, id: string) {
    const group = groups.find((item) => item.label === groupLabel);
    const found = group?.options.find(
        (item) => !("kind" in item && item.kind === "separator") && item.id === id,
    );
    if (!found || "kind" in found) throw new Error(`missing ${groupLabel}/${id}`);
    return found;
}

function callbacks(overrides: Partial<AppMenuCallbacks> = {}): AppMenuCallbacks {
    return {
        about: () => undefined,
        sendFeedback: () => undefined,
        openGuide: () => undefined,
        createNewTab: () => undefined,
        openNewFile: () => undefined,
        saveGame: () => undefined,
        saveGameTo: () => undefined,
        openAccounts: () => undefined,
        openEngines: () => undefined,
        openSettings: () => undefined,
        exit: () => undefined,
        toggleFullscreen: () => undefined,
        toggleFocusMode: () => undefined,
        ...overrides,
    };
}

const t = (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key;

function idsOfItems(items: MenuAction[]): string[] {
    return items.flatMap((option) =>
        "kind" in option && option.kind === "separator" ? [] : option.id ? [option.id] : [],
    );
}

function item(items: MenuAction[], id: string) {
    const found = items.find(
        (option) => !("kind" in option && option.kind === "separator") && option.id === id,
    );
    if (!found || "kind" in found) throw new Error(`missing ${id}`);
    return found;
}

test("the in-app menu is flat, omits the Advanced entries, and drops Exit on macOS", () => {
    const actions = callbacks();
    const linux = buildInAppMenuItems({
        t,
        isMacOS: false,
        newTabShortcut: "Ctrl+T",
        openFileShortcut: "Ctrl+O",
        saveShortcut: "ctrl+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: actions,
    });
    expect(linux.map((option) => ("kind" in option ? "|" : option.id))).toEqual([
        "new_tab",
        "open_file",
        "|",
        "save",
        "save_to",
        "|",
        "accounts",
        "engines",
        "settings",
        "|",
        "toggle_fullscreen",
        "toggle_focus_mode",
        "|",
        "guide",
        "send_feedback",
        "about",
        "|",
        "exit",
    ]);
    expect(idsOfItems(linux)).toEqual([
        "new_tab",
        "open_file",
        "save",
        "save_to",
        "accounts",
        "engines",
        "settings",
        "toggle_fullscreen",
        "toggle_focus_mode",
        "guide",
        "send_feedback",
        "about",
        "exit",
    ]);
    expect(item(linux, "save").label).toBe("Common.Save");
    expect(item(linux, "save").shortcut).toBe("ctrl+s");
    expect(item(linux, "save").action).toBe(actions.saveGame);
    expect(item(linux, "save_to").label).toBe("Board.Database.Save");
    expect(item(linux, "new_tab").shortcut).toBe("Ctrl+T");
    expect(item(linux, "open_file").shortcut).toBe("Ctrl+O");
    expect(item(linux, "toggle_fullscreen").shortcut).toBe("F11");
    expect(item(linux, "new_tab").action).toBe(actions.createNewTab);
    expect(item(linux, "accounts").action).toBe(actions.openAccounts);
    expect(item(linux, "engines").action).toBe(actions.openEngines);
    expect(item(linux, "settings").action).toBe(actions.openSettings);
    expect(item(linux, "exit").action).toBe(actions.exit);
    expect(linux.some((option) => "id" in option && option.id === "reload")).toBe(false);
    expect(linux.some((option) => "id" in option && option.id === "clear_saved_data")).toBe(false);
    expect(linux.some((option) => "id" in option && option.id === "logs")).toBe(false);

    const mac = buildInAppMenuItems({
        t,
        isMacOS: true,
        newTabShortcut: "Cmd+T",
        openFileShortcut: "Cmd+O",
        saveShortcut: "meta+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: actions,
    });
    expect(idsOfItems(mac)).toEqual([
        "new_tab",
        "open_file",
        "save",
        "save_to",
        "accounts",
        "engines",
        "settings",
        "toggle_fullscreen",
        "toggle_focus_mode",
        "guide",
        "send_feedback",
        "about",
    ]);
    expect(item(mac, "toggle_fullscreen").shortcut).toBe("Ctrl+Cmd+F");
});

test("the focus-mode entry names what choosing it does and carries the configured shortcut", () => {
    const actions = callbacks();
    const build = (on: boolean) =>
        buildInAppMenuItems({
            t,
            isMacOS: false,
            newTabShortcut: "Ctrl+T",
            openFileShortcut: "Ctrl+O",
            saveShortcut: "ctrl+s",
            focusMode: { on, shortcut: "alt+h" },
            callbacks: actions,
        });
    expect(item(build(false), "toggle_focus_mode").label).toBe("Menu.View.HideHeader");
    expect(item(build(true), "toggle_focus_mode").label).toBe("Menu.View.ShowHeader");
    expect(item(build(false), "toggle_focus_mode").shortcut).toBe("alt+h");
    expect(item(build(true), "toggle_focus_mode").action).toBe(actions.toggleFocusMode);
    const tree = buildAppMenuTree({
        t,
        isMacOS: true,
        newTabShortcut: "Cmd+T",
        openFileShortcut: "Cmd+O",
        saveShortcut: "meta+s",
        focusMode: { on: true, shortcut: "meta+shift+f" },
        callbacks: actions,
    });
    expect(option(tree, "Menu.View", "toggle_focus_mode").label).toBe("Menu.View.ShowHeader");
    expect(option(tree, "Menu.View", "toggle_focus_mode").shortcut).toBe("meta+shift+f");
});

test("macOS tree has Application/Edit, no File Exit, no Help About", () => {
    const actions = callbacks();
    const groups = buildAppMenuTree({
        t,
        isMacOS: true,
        newTabShortcut: "Cmd+T",
        openFileShortcut: "Cmd+O",
        saveShortcut: "meta+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: actions,
    });
    expect(groups.map((group) => group.label)).toEqual([
        "Menu.Application.Menu",
        "Menu.File",
        "Menu.Edit",
        "Menu.View",
        "Menu.Help",
    ]);
    expect(idsOf(groups, "Menu.File")).toEqual(["new_tab", "open_file", "save", "save_to"]);
    expect(option(groups, "Menu.File", "save").shortcut).toBe("meta+s");
    expect(idsOf(groups, "Menu.View")).toEqual(["toggle_fullscreen", "toggle_focus_mode"]);
    expect(option(groups, "Menu.View", "toggle_focus_mode").action).toBe(actions.toggleFocusMode);
    expect(idsOf(groups, "Menu.Help")).toEqual(["guide", "send_feedback"]);
    expect(option(groups, "Menu.Application.Menu", "about").action).toBe(actions.about);
    expect(option(groups, "Menu.Application.Menu", "settings").action).toBe(actions.openSettings);
    expect(option(groups, "Menu.File", "new_tab").action).toBe(actions.createNewTab);
    expect(option(groups, "Menu.File", "open_file").action).toBe(actions.openNewFile);
    expect(option(groups, "Menu.View", "toggle_fullscreen").action).toBe(actions.toggleFullscreen);
    expect(option(groups, "Menu.Help", "send_feedback").action).toBe(actions.sendFeedback);
    expect(
        groups.some((group) => group.options.some((item) => "id" in item && item.id === "reload")),
    ).toBe(false);
    expect(
        groups.some((group) =>
            group.options.some((item) => "id" in item && item.id === "clear_saved_data"),
        ),
    ).toBe(false);
    expect(
        groups.some((group) => group.options.some((item) => "id" in item && item.id === "logs")),
    ).toBe(false);
    const hide = groups[0].options.find((item) => "item" in item && item.item === "Hide");
    const quit = option(groups, "Menu.Application.Menu", "quit");
    expect(hide).toBeDefined();
    expect(quit.shortcut).toBe("cmd+q");
    expect(quit.action).toBe(actions.exit);
    expect(
        groups.some((group) =>
            group.options.some((item) => "item" in item && item.item === "Quit"),
        ),
    ).toBe(false);
    expect(option(groups, "Menu.View", "toggle_fullscreen").shortcut).toBe("Ctrl+Cmd+F");
});

test("Help menu and in-app menu always show Guide first and include Assistant only when showAssistant is true", () => {
    let openedAssistant = 0;
    let openedGuide = 0;
    const actions = callbacks({
        openGuide: () => {
            openedGuide += 1;
        },
        openAssistant: () => {
            openedAssistant += 1;
        },
    });
    const hiddenTree = buildAppMenuTree({
        t,
        isMacOS: true,
        showAssistant: false,
        newTabShortcut: "Cmd+T",
        openFileShortcut: "Cmd+O",
        saveShortcut: "meta+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: actions,
    });
    expect(idsOf(hiddenTree, "Menu.Help")).toEqual(["guide", "send_feedback"]);
    expect(option(hiddenTree, "Menu.Help", "guide").action).toBe(actions.openGuide);
    option(hiddenTree, "Menu.Help", "guide").action?.();
    expect(openedGuide).toBe(1);

    const shownTree = buildAppMenuTree({
        t,
        isMacOS: true,
        showAssistant: true,
        newTabShortcut: "Cmd+T",
        openFileShortcut: "Cmd+O",
        saveShortcut: "meta+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: actions,
    });
    expect(idsOf(shownTree, "Menu.Help")).toEqual(["guide", "assistant", "send_feedback"]);
    expect(option(shownTree, "Menu.Help", "guide").action).toBe(actions.openGuide);
    option(shownTree, "Menu.Help", "assistant").action?.();
    expect(openedAssistant).toBe(1);

    const hiddenItems = buildInAppMenuItems({
        t,
        isMacOS: false,
        showAssistant: false,
        newTabShortcut: "Ctrl+T",
        openFileShortcut: "Ctrl+O",
        saveShortcut: "ctrl+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: actions,
    });
    const hiddenHelpSlice = idsOfItems(hiddenItems).slice(idsOfItems(hiddenItems).indexOf("guide"));
    expect(hiddenHelpSlice).toEqual(["guide", "send_feedback", "about", "exit"]);
    expect(item(hiddenItems, "guide").action).toBe(actions.openGuide);

    const shownItems = buildInAppMenuItems({
        t,
        isMacOS: false,
        showAssistant: true,
        newTabShortcut: "Ctrl+T",
        openFileShortcut: "Ctrl+O",
        saveShortcut: "ctrl+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: actions,
    });
    const shownHelpSlice = idsOfItems(shownItems).slice(idsOfItems(shownItems).indexOf("guide"));
    expect(shownHelpSlice).toEqual(["guide", "assistant", "send_feedback", "about", "exit"]);
    expect(item(shownItems, "guide").action).toBe(actions.openGuide);
    item(shownItems, "assistant").action?.();
    expect(openedAssistant).toBe(2);
    item(shownItems, "guide").action?.();
    expect(openedGuide).toBe(2);
});

test("View menu and in-app menu include Save layout as… and Layouts… only when showBoardLayouts is true, without accelerators", () => {
    let savedAs = 0;
    let managed = 0;
    const actions = callbacks({
        saveLayoutAs: () => {
            savedAs += 1;
        },
        manageLayouts: () => {
            managed += 1;
        },
    });

    const hiddenTree = buildAppMenuTree({
        t,
        isMacOS: true,
        showBoardLayouts: false,
        newTabShortcut: "Cmd+T",
        openFileShortcut: "Cmd+O",
        saveShortcut: "meta+s",
        focusMode: { on: false, shortcut: "meta+shift+f" },
        callbacks: actions,
    });
    expect(idsOf(hiddenTree, "Menu.View")).toEqual(["toggle_fullscreen", "toggle_focus_mode"]);

    const shownTree = buildAppMenuTree({
        t,
        isMacOS: true,
        showBoardLayouts: true,
        newTabShortcut: "Cmd+T",
        openFileShortcut: "Cmd+O",
        saveShortcut: "meta+s",
        focusMode: { on: false, shortcut: "meta+shift+f" },
        callbacks: actions,
    });
    expect(idsOf(shownTree, "Menu.View")).toEqual([
        "toggle_fullscreen",
        "toggle_focus_mode",
        "save_layout_as",
        "manage_layouts",
    ]);
    expect(option(shownTree, "Menu.View", "save_layout_as").shortcut).toBeUndefined();
    expect(option(shownTree, "Menu.View", "manage_layouts").shortcut).toBeUndefined();
    option(shownTree, "Menu.View", "save_layout_as").action?.();
    option(shownTree, "Menu.View", "manage_layouts").action?.();
    expect(savedAs).toBe(1);
    expect(managed).toBe(1);

    const hiddenItems = buildInAppMenuItems({
        t,
        isMacOS: false,
        showBoardLayouts: false,
        newTabShortcut: "Ctrl+T",
        openFileShortcut: "Ctrl+O",
        saveShortcut: "ctrl+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: actions,
    });
    expect(idsOfItems(hiddenItems)).not.toContain("save_layout_as");
    expect(idsOfItems(hiddenItems)).not.toContain("manage_layouts");

    const shownItems = buildInAppMenuItems({
        t,
        isMacOS: false,
        showBoardLayouts: true,
        newTabShortcut: "Ctrl+T",
        openFileShortcut: "Ctrl+O",
        saveShortcut: "ctrl+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: actions,
    });
    expect(item(shownItems, "save_layout_as").shortcut).toBeUndefined();
    expect(item(shownItems, "manage_layouts").shortcut).toBeUndefined();
    item(shownItems, "save_layout_as").action?.();
    item(shownItems, "manage_layouts").action?.();
    expect(savedAs).toBe(2);
    expect(managed).toBe(2);
});

test("changing t changes labels", () => {
    const items = buildInAppMenuItems({
        t: (key) => `${key}.fr`,
        isMacOS: false,
        newTabShortcut: "Ctrl+T",
        openFileShortcut: "Ctrl+O",
        saveShortcut: "ctrl+s",
        focusMode: { on: false, shortcut: "ctrl+shift+f" },
        callbacks: callbacks(),
    });
    expect(item(items, "exit").label).toBe("Menu.File.Exit.fr");
    expect(item(items, "new_tab").label).toBe("Menu.File.NewTab.fr");
});

test("openPgnFromMenu waits for committed admission before navigating", async () => {
    const opened = deferred<string | null>();
    let navigated = false;
    const pending = openPgnFromMenu({
        pickPgnFile: async () => ({ name: "a.pgn" }),
        navigate: async () => {
            navigated = true;
        },
        openFile: () => opened.promise,
    });
    await Promise.resolve();
    expect(navigated).toBe(false);
    let settled = false;
    void pending.then(() => {
        settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    opened.resolve("tab-id");
    await pending;
    expect(settled).toBe(true);
    expect(navigated).toBe(true);

    let navigatedAfterCancel = false;
    await openPgnFromMenu({
        pickPgnFile: async () => null,
        navigate: async () => {
            navigatedAfterCancel = true;
        },
        openFile: async () => {
            throw new Error("should not open");
        },
    });
    expect(navigatedAfterCancel).toBe(false);

    let navigatedAfterRefusal = false;
    await openPgnFromMenu({
        pickPgnFile: async () => ({ name: "a.pgn" }),
        navigate: async () => {
            navigatedAfterRefusal = true;
        },
        openFile: async () => null,
    });
    expect(navigatedAfterRefusal).toBe(false);
});

test("openPgnFromMenu rejects when openFile rejects", async () => {
    await expect(
        openPgnFromMenu({
            pickPgnFile: async () => ({ name: "a.pgn" }),
            navigate: async () => undefined,
            openFile: async () => {
                throw new Error("read failed");
            },
        }),
    ).rejects.toThrow("read failed");
});

test.each(["/settings", "/accounts", "/engines", "/guide"] as const)(
    "openPageFromMenu awaits navigate to %s",
    async (to) => {
        const nav = deferred<void>();
        let navigatedTo: string | undefined;
        const pending = openPageFromMenu({
            navigate: (opts) => {
                navigatedTo = opts.to;
                return nav.promise;
            },
            to,
        });
        let settled = false;
        void pending.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(navigatedTo).toBe(to);
        nav.resolve();
        await pending;
        expect(settled).toBe(true);
    },
);

test("bindAppMenuCallbacks returns runMenu's promise for each wired command", async () => {
    const opened = deferred<void>();
    const seen: unknown[] = [];
    const callbacks = bindAppMenuCallbacks({
        runMenu: async (command, successMessage) => {
            try {
                await command();
                if (successMessage) seen.push(successMessage);
            } catch (error) {
                seen.push(error);
            }
        },
        about: () => {
            seen.push("about");
        },
        sendFeedback: () => {
            seen.push("send-feedback");
        },
        openGuide: async () => {
            seen.push("guide");
        },
        createNewTab: () => opened.promise,
        openNewFile: async () => {
            throw new Error("open failed");
        },
        saveGame: async () => {
            seen.push("save");
        },
        saveGameTo: async () => {
            seen.push("save-to");
        },
        openAccounts: async () => {
            seen.push("accounts");
        },
        openEngines: async () => {
            seen.push("engines");
        },
        openSettings: async () => undefined,
        exit: async () => undefined,
        toggleFullscreen: async () => undefined,
        toggleFocusMode: () => {
            seen.push("focus-mode");
        },
    });

    const pending = callbacks.createNewTab();
    expect(pending).toBeInstanceOf(Promise);
    let settled = false;
    void Promise.resolve(pending).then(() => {
        settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    opened.resolve();
    await pending;
    expect(settled).toBe(true);

    await callbacks.openNewFile();
    expect(seen).toEqual([expect.objectContaining({ message: "open failed" })]);

    await callbacks.openSettings();
    await callbacks.exit();
    await callbacks.toggleFullscreen();
    await callbacks.openAccounts();
    await callbacks.openEngines();
    await callbacks.openGuide();
    expect(seen).toEqual([
        expect.objectContaining({ message: "open failed" }),
        "accounts",
        "engines",
        "guide",
    ]);

    callbacks.about();
    callbacks.sendFeedback();
    callbacks.toggleFocusMode();
    expect(seen).toEqual([
        expect.objectContaining({ message: "open failed" }),
        "accounts",
        "engines",
        "guide",
        "about",
        "send-feedback",
        "focus-mode",
    ]);
});

test("runNativeMenuAction notifies string rejections and skips Cancellation", async () => {
    const seen: unknown[] = [];
    await runNativeMenuAction(
        async () => {
            throw "permission denied";
        },
        (error) => {
            seen.push(error);
        },
    );
    expect(seen).toEqual(["permission denied"]);

    await runNativeMenuAction(
        async () => {
            throw new Error("Cancellation");
        },
        (error) => {
            seen.push(error);
        },
    );
    expect(seen).toEqual(["permission denied"]);
});

function fakeMenu(label: string, setAs?: () => Promise<MenuHandle | null>): MenuHandle {
    return {
        setAsAppMenu: setAs ?? (async () => null),
        close: async () => undefined,
        label,
    } as MenuHandle & { label: string };
}

test("installAppMenuSurface createMenu reject notifies and skips later mutations", async () => {
    const calls: string[] = [];
    const notified: unknown[] = [];
    const result = await installAppMenuSurface({
        groups: [],
        wantRealMenu: true,
        wantDecorations: true,
        previousDecorationsApplied: false,
        isCurrent: () => true,
        createMenu: async () => {
            throw new Error("create failed");
        },
        setDecorations: async () => {
            calls.push("decorations");
        },
        closeMenu: async () => {
            calls.push("close");
        },
        notify: (error) => {
            notified.push(error);
        },
    });
    expect(result.decorationsApplied).toBe(false);
    expect(calls).toEqual([]);
    expect(notified).toHaveLength(1);
});

test("stale after createMenu closes the new menu and does not install", async () => {
    const closed: string[] = [];
    let current = true;
    const created = fakeMenu("new", async () => {
        throw new Error("should not install");
    });
    const result = await installAppMenuSurface({
        groups: [],
        wantRealMenu: true,
        wantDecorations: true,
        previousDecorationsApplied: true,
        isCurrent: () => current,
        createMenu: async () => {
            current = false;
            return created;
        },
        setDecorations: async () => {
            throw new Error("should not decorate");
        },
        closeMenu: async (menu) => {
            closed.push((menu as MenuHandle & { label?: string }).label ?? "menu");
        },
        notify: () => {
            throw new Error("should not notify");
        },
    });
    expect(result.decorationsApplied).toBe(true);
    expect(closed).toEqual(["new"]);
});

test("wantRealMenu false creates an empty group list", async () => {
    let received: MenuGroup[] | undefined;
    await installAppMenuSurface({
        groups: [{ label: "File", options: [] }],
        wantRealMenu: false,
        wantDecorations: false,
        previousDecorationsApplied: false,
        isCurrent: () => true,
        createMenu: async (groups) => {
            received = groups;
            return fakeMenu("empty");
        },
        setDecorations: async () => undefined,
        closeMenu: async () => undefined,
        notify: () => undefined,
    });
    expect(received).toEqual([]);
});

test("setAsAppMenu reject closes created menu and keeps previous decorations", async () => {
    const closed: string[] = [];
    const created = fakeMenu("new", async () => {
        throw new Error("install failed");
    });
    const result = await installAppMenuSurface({
        groups: [],
        wantRealMenu: true,
        wantDecorations: true,
        previousDecorationsApplied: true,
        isCurrent: () => true,
        createMenu: async () => created,
        setDecorations: async () => {
            throw new Error("should not decorate");
        },
        closeMenu: async (menu) => {
            closed.push((menu as MenuHandle & { label?: string }).label ?? "menu");
        },
        notify: () => undefined,
    });
    expect(result.decorationsApplied).toBe(true);
    expect(closed).toEqual(["new"]);
});

test("setDecorations reject keeps previous decorationsApplied", async () => {
    const result = await installAppMenuSurface({
        groups: [],
        wantRealMenu: true,
        wantDecorations: false,
        previousDecorationsApplied: true,
        isCurrent: () => true,
        createMenu: async () => fakeMenu("new"),
        setDecorations: async () => {
            throw new Error("deco failed");
        },
        closeMenu: async () => undefined,
        notify: () => undefined,
    });
    expect(result.decorationsApplied).toBe(true);
});

test("stale after setAsAppMenu skips decorations and keeps previous state", async () => {
    let current = true;
    const decorated: boolean[] = [];
    const result = await installAppMenuSurface({
        groups: [],
        wantRealMenu: true,
        wantDecorations: true,
        previousDecorationsApplied: false,
        isCurrent: () => current,
        createMenu: async () =>
            fakeMenu("new", async () => {
                current = false;
                return null;
            }),
        setDecorations: async (on) => {
            decorated.push(on);
        },
        closeMenu: async () => undefined,
        notify: () => {
            throw new Error("should not notify");
        },
    });
    expect(result.decorationsApplied).toBe(false);
    expect(decorated).toEqual([]);
});

test("stale after setDecorations does not report the new decorations as applied", async () => {
    let current = true;
    const result = await installAppMenuSurface({
        groups: [],
        wantRealMenu: true,
        wantDecorations: true,
        previousDecorationsApplied: false,
        isCurrent: () => current,
        createMenu: async () => fakeMenu("new"),
        setDecorations: async () => {
            current = false;
        },
        closeMenu: async () => undefined,
        notify: () => undefined,
    });
    expect(result.decorationsApplied).toBe(false);
});

test("overlapping installs are serialized: second createMenu waits for the first chain item", async () => {
    const firstSet = deferred<MenuHandle | null>();
    const order: string[] = [];
    const first = installAppMenuSurface({
        groups: [],
        wantRealMenu: true,
        wantDecorations: true,
        previousDecorationsApplied: false,
        isCurrent: () => true,
        createMenu: async () => {
            order.push("create-1");
            return fakeMenu("one", () => {
                order.push("set-1");
                return firstSet.promise;
            });
        },
        setDecorations: async () => {
            order.push("deco-1");
        },
        closeMenu: async () => undefined,
        notify: () => undefined,
    });
    await Promise.resolve();
    const second = installAppMenuSurface({
        groups: [],
        wantRealMenu: true,
        wantDecorations: true,
        previousDecorationsApplied: false,
        isCurrent: () => true,
        createMenu: async () => {
            order.push("create-2");
            return fakeMenu("two");
        },
        setDecorations: async () => {
            order.push("deco-2");
        },
        closeMenu: async () => undefined,
        notify: () => undefined,
    });
    await Promise.resolve();
    expect(order).toEqual(["create-1", "set-1"]);
    firstSet.resolve(null);
    await first;
    await second;
    expect(order[0]).toBe("create-1");
    expect(order.indexOf("create-2")).toBeGreaterThan(order.indexOf("set-1"));
});

test("stale setAsAppMenu rejection does not notify", async () => {
    const notified: unknown[] = [];
    let current = true;
    const setAs = deferred<MenuHandle | null>();
    const pending = installAppMenuSurface({
        groups: [],
        wantRealMenu: true,
        wantDecorations: true,
        previousDecorationsApplied: false,
        isCurrent: () => current,
        createMenu: async () =>
            fakeMenu("new", () => {
                current = false;
                return setAs.promise;
            }),
        setDecorations: async () => undefined,
        closeMenu: async () => undefined,
        notify: (error) => {
            notified.push(error);
        },
    });
    setAs.reject(new Error("late fail"));
    await pending;
    expect(notified).toEqual([]);
});

test("surface helpers match the current linux/win32/macos coupling", () => {
    expect(menuWindowPlatform("linux")).toBe("linux");
    expect(menuWindowPlatform("darwin")).toBe("other");
    expect(wantNativeDecorations(true, "linux")).toBe(true);
    expect(wantNativeDecorations(true, "win32")).toBe(true);
    expect(wantNativeDecorations(false, "other")).toBe(true);
    expect(wantRealMenu("linux")).toBe(false);
    expect(wantRealMenu("win32")).toBe(false);
    expect(wantRealMenu("other")).toBe(true);
});

test("resize handles appear only on Linux with the custom window controls", () => {
    expect(renderResizeHandles("linux", true)).toBe(true);
    expect(renderResizeHandles("linux", false)).toBe(false);
    expect(renderResizeHandles("win32", true)).toBe(false);
    expect(renderResizeHandles("other", true)).toBe(false);
});

function fakeResource(label: string): NativeMenuResource & { label: string } {
    return {
        label,
        close: async () => undefined,
    };
}

test("assembleNativeMenuResources builds items sequentially and closes earlier resources on failure", async () => {
    const first = deferred<NativeMenuResource & { label: string }>();
    const order: string[] = [];
    const closed: string[] = [];
    const resource = (label: string): NativeMenuResource & { label: string } => ({
        label,
        close: async () => {
            closed.push(label);
        },
    });
    const pending = assembleNativeMenuResources(
        [
            {
                label: "File",
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
            },
        ],
        {
            separator: async () => resource("sep"),
            predefined: async () => resource("pre"),
            item: async (option) => {
                order.push(option.id ?? "item");
                if (option.id === "a") return first.promise;
                throw new Error("b failed");
            },
            submenu: async () => resource("sub"),
            menu: async () => resource("menu"),
        },
    );
    await Promise.resolve();
    expect(order).toEqual(["a"]);
    first.resolve(resource("a"));
    await expect(pending).rejects.toThrow("b failed");
    expect(order).toEqual(["a", "b"]);
    expect(closed).toEqual(["a"]);
});

test("assembleNativeMenuResources does not start the next group until the current submenu exists", async () => {
    const submenu = deferred<NativeMenuResource>();
    const order: string[] = [];
    const pending = assembleNativeMenuResources(
        [
            { label: "File", options: [{ id: "a", label: "A" }] },
            { label: "Help", options: [{ id: "b", label: "B" }] },
        ],
        {
            separator: async () => fakeResource("sep"),
            predefined: async () => fakeResource("pre"),
            item: async (option) => {
                order.push(`item:${option.id}`);
                return fakeResource(option.id ?? "item");
            },
            submenu: async (label) => {
                order.push(`sub:${label}`);
                if (label === "File") return submenu.promise;
                return fakeResource(label);
            },
            menu: async () => {
                order.push("menu");
                return fakeResource("menu");
            },
        },
    );
    await Promise.resolve();
    expect(order).toEqual(["item:a", "sub:File"]);
    submenu.resolve(fakeResource("File"));
    await pending;
    expect(order).toEqual(["item:a", "sub:File", "item:b", "sub:Help", "menu"]);
});

test("View menu and in-app menu offer Show the tabs only on the board with its tab strip hidden", () => {
    let shown = 0;
    const actions = callbacks({
        showTabs: () => {
            shown += 1;
        },
    });
    const base = {
        t,
        newTabShortcut: "Cmd+T",
        openFileShortcut: "Cmd+O",
        saveShortcut: "meta+s",
        focusMode: { on: false, shortcut: "meta+shift+f" },
        callbacks: actions,
    };

    const visibleTabs = buildAppMenuTree({ ...base, isMacOS: true, showBoardLayouts: true });
    expect(idsOf(visibleTabs, "Menu.View")).not.toContain("show_tabs");

    const offBoard = buildAppMenuTree({
        ...base,
        isMacOS: true,
        showBoardLayouts: false,
        showBoardTabsItem: true,
    });
    expect(idsOf(offBoard, "Menu.View")).not.toContain("show_tabs");

    const hiddenTabs = buildAppMenuTree({
        ...base,
        isMacOS: true,
        showBoardLayouts: true,
        showBoardTabsItem: true,
    });
    expect(idsOf(hiddenTabs, "Menu.View")).toEqual([
        "toggle_fullscreen",
        "toggle_focus_mode",
        "save_layout_as",
        "manage_layouts",
        "show_tabs",
    ]);
    expect(option(hiddenTabs, "Menu.View", "show_tabs").label).toBe("Board.Arrange.ShowTabs");
    option(hiddenTabs, "Menu.View", "show_tabs").action?.();
    expect(shown).toBe(1);

    const inApp = buildInAppMenuItems({
        ...base,
        isMacOS: false,
        showBoardLayouts: true,
        showBoardTabsItem: true,
    });
    item(inApp, "show_tabs").action?.();
    expect(shown).toBe(2);
});
