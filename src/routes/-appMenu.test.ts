import { afterEach, expect, test, vi } from "vitest";
import {
    assembleNativeMenuResources,
    buildAppMenuTree,
    clearSavedDataFromMenu,
    createNewTabFromMenu,
    installAppMenuSurface,
    menuWindowPlatform,
    openPgnFromMenu,
    openSettingsFromMenu,
    renderResizeHandles,
    renderTopBar,
    resetInstallChainForTests,
    runNativeMenuAction,
    bindAppMenuCallbacks,
    wantNativeDecorations,
    type AppMenuCallbacks,
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
        createNewTab: () => undefined,
        openNewFile: () => undefined,
        openSettings: () => undefined,
        exit: () => undefined,
        reload: () => undefined,
        toggleFullscreen: () => undefined,
        documentation: () => undefined,
        clearSavedData: () => undefined,
        openLogs: () => undefined,
        ...overrides,
    };
}

const t = (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key;

test("non-macOS tree has File/View/Help with Exit and About", () => {
    const actions = callbacks();
    const groups = buildAppMenuTree({
        t,
        isMacOS: false,
        newTabShortcut: "Ctrl+T",
        openFileShortcut: "Ctrl+O",
        callbacks: actions,
    });
    expect(groups.map((group) => group.label)).toEqual(["Menu.File", "Menu.View", "Menu.Help"]);
    expect(idsOf(groups, "Menu.File")).toEqual(["new_tab", "open_file", "exit"]);
    expect(idsOf(groups, "Menu.View")).toEqual(["reload", "toggle_fullscreen"]);
    expect(idsOf(groups, "Menu.Help")).toEqual([
        "documentation",
        "send_feedback",
        "clear_saved_data",
        "logs",
        "about",
    ]);
    expect(option(groups, "Menu.File", "new_tab").shortcut).toBe("Ctrl+T");
    expect(option(groups, "Menu.File", "open_file").shortcut).toBe("Ctrl+O");
    expect(option(groups, "Menu.View", "toggle_fullscreen").shortcut).toBe("F11");
    expect(option(groups, "Menu.File", "new_tab").action).toBe(actions.createNewTab);
    expect(option(groups, "Menu.File", "open_file").action).toBe(actions.openNewFile);
    expect(option(groups, "Menu.File", "exit").action).toBe(actions.exit);
    expect(option(groups, "Menu.View", "reload").action).toBe(actions.reload);
    expect(option(groups, "Menu.View", "toggle_fullscreen").action).toBe(actions.toggleFullscreen);
    expect(option(groups, "Menu.Help", "documentation").action).toBe(actions.documentation);
    expect(option(groups, "Menu.Help", "send_feedback").action).toBe(actions.sendFeedback);
    expect(option(groups, "Menu.Help", "clear_saved_data").action).toBe(actions.clearSavedData);
    expect(option(groups, "Menu.Help", "logs").action).toBe(actions.openLogs);
    expect(option(groups, "Menu.Help", "about").action).toBe(actions.about);
    expect(groups.some((group) => group.options.some((item) => "item" in item && item.item))).toBe(
        false,
    );
});

test("macOS tree has Application/Edit, no File Exit, no Help About", () => {
    const actions = callbacks();
    const groups = buildAppMenuTree({
        t,
        isMacOS: true,
        newTabShortcut: "Cmd+T",
        openFileShortcut: "Cmd+O",
        callbacks: actions,
    });
    expect(groups.map((group) => group.label)).toEqual([
        "Menu.Application.Menu",
        "Menu.File",
        "Menu.Edit",
        "Menu.View",
        "Menu.Help",
    ]);
    expect(idsOf(groups, "Menu.File")).toEqual(["new_tab", "open_file"]);
    expect(idsOf(groups, "Menu.Help")).toEqual([
        "documentation",
        "send_feedback",
        "clear_saved_data",
        "logs",
    ]);
    expect(option(groups, "Menu.Application.Menu", "about").action).toBe(actions.about);
    expect(option(groups, "Menu.Application.Menu", "settings").action).toBe(actions.openSettings);
    expect(option(groups, "Menu.File", "new_tab").action).toBe(actions.createNewTab);
    expect(option(groups, "Menu.File", "open_file").action).toBe(actions.openNewFile);
    expect(option(groups, "Menu.View", "reload").action).toBe(actions.reload);
    expect(option(groups, "Menu.View", "toggle_fullscreen").action).toBe(actions.toggleFullscreen);
    expect(option(groups, "Menu.Help", "documentation").action).toBe(actions.documentation);
    expect(option(groups, "Menu.Help", "send_feedback").action).toBe(actions.sendFeedback);
    expect(option(groups, "Menu.Help", "clear_saved_data").action).toBe(actions.clearSavedData);
    expect(option(groups, "Menu.Help", "logs").action).toBe(actions.openLogs);
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

test("changing t changes labels", () => {
    const groups = buildAppMenuTree({
        t: (key) => `${key}.fr`,
        isMacOS: false,
        newTabShortcut: "Ctrl+T",
        openFileShortcut: "Ctrl+O",
        callbacks: callbacks(),
    });
    expect(groups[0].label).toBe("Menu.File.fr");
    expect(option(groups, "Menu.File.fr", "exit").label).toBe("Menu.File.Exit.fr");
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

test("createNewTabFromMenu waits for committed admission before navigating", async () => {
    const created = deferred<string | null>();
    let navigated = false;
    const pending = createNewTabFromMenu({
        navigate: async () => {
            navigated = true;
        },
        createTab: () => created.promise,
    });
    await Promise.resolve();
    expect(navigated).toBe(false);
    let settled = false;
    void pending.then(() => {
        settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    created.resolve("tab-id");
    await pending;
    expect(navigated).toBe(true);
});

test("createNewTabFromMenu preserves null and rejected creation outcomes", async () => {
    const navigate = vi.fn();
    await createNewTabFromMenu({ navigate, createTab: async () => null });
    expect(navigate).not.toHaveBeenCalled();

    await expect(
        createNewTabFromMenu({
            navigate,
            createTab: async () => {
                throw new Error("create failed");
            },
        }),
    ).rejects.toThrow("create failed");
    expect(navigate).not.toHaveBeenCalled();
});

test("openSettingsFromMenu awaits navigate", async () => {
    const nav = deferred<void>();
    const pending = openSettingsFromMenu({ navigate: () => nav.promise });
    let settled = false;
    void pending.then(() => {
        settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    nav.resolve();
    await pending;
});

test("clearSavedDataFromMenu does not clear when ask is false", async () => {
    let cleared = false;
    await clearSavedDataFromMenu({
        ask: async () => false,
        confirmMessage: "sure?",
        title: "clear",
        clear: () => {
            cleared = true;
        },
    });
    expect(cleared).toBe(false);
});

test("clearSavedDataFromMenu clears when ask is true", async () => {
    const clear = deferred<void>();
    const pending = clearSavedDataFromMenu({
        ask: async () => true,
        confirmMessage: "sure?",
        title: "clear",
        clear: () => clear.promise,
    });
    let settled = false;
    void pending.then(() => {
        settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    clear.resolve();
    await pending;
    expect(settled).toBe(true);
});

test("clearSavedDataFromMenu rejects when clearing rejects", async () => {
    const clear = deferred<void>();
    const pending = clearSavedDataFromMenu({
        ask: async () => true,
        confirmMessage: "sure?",
        title: "clear",
        clear: () => clear.promise,
    });
    clear.reject(new Error("migration failed"));
    await expect(pending).rejects.toThrow("migration failed");
});

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
        createNewTab: () => opened.promise,
        openNewFile: async () => {
            throw new Error("open failed");
        },
        openSettings: async () => undefined,
        exit: async () => undefined,
        reload: () => {
            seen.push("reload");
        },
        toggleFullscreen: async () => undefined,
        documentation: async () => undefined,
        clearSavedData: async () => {
            throw new Error("clear failed");
        },
        openLogs: async () => undefined,
        openLogsSuccessMessage: "logs-ok",
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
    await callbacks.documentation();
    await callbacks.clearSavedData();
    expect(seen).toEqual([
        expect.objectContaining({ message: "open failed" }),
        expect.objectContaining({ message: "clear failed" }),
    ]);

    callbacks.about();
    callbacks.sendFeedback();
    callbacks.reload();
    await callbacks.openLogs();
    expect(seen).toEqual([
        expect.objectContaining({ message: "open failed" }),
        expect.objectContaining({ message: "clear failed" }),
        "about",
        "send-feedback",
        "reload",
        "logs-ok",
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
    expect(renderTopBar(true, "linux")).toBe(false);
    expect(renderTopBar(false, "linux")).toBe(true);
    expect(renderTopBar(true, "win32")).toBe(false);
    expect(renderTopBar(false, "other")).toBe(false);
    expect(wantNativeDecorations(false, "other")).toBe(true);
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
