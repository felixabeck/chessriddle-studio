import { errorUnlessCancelled } from "@/platform/errors";
import { createNativeListenerLifecycle } from "@/platform/listenerLifecycle";

export type MenuTranslator = (key: string, options?: { defaultValue?: string }) => string;

export type MenuSeparator = { kind: "separator" };

export type MenuItemAction = {
    kind?: never;
    id?: string;
    label: string;
    shortcut?: string;
    action?: () => void;
    item?: "Hide" | "Copy" | "Cut" | "Paste" | "SelectAll" | "Undo" | "Redo" | "Quit";
};

export type MenuAction = MenuItemAction | MenuSeparator;

export type MenuGroup = {
    label: string;
    options: MenuAction[];
};

export type AppMenuCallbacks = {
    about: () => void;
    sendFeedback: () => void;
    createNewTab: () => void | Promise<void>;
    openNewFile: () => void | Promise<void>;
    openSettings: () => void | Promise<void>;
    exit: () => void | Promise<void>;
    reload: () => void;
    toggleFullscreen: () => void | Promise<void>;
    clearSavedData: () => void | Promise<void>;
    openLogs: () => void | Promise<void>;
};

export type WindowPlatform = "win32" | "linux" | "other";

const menuEllipsis = String.fromCodePoint(0x2026);

export function menuWindowPlatform(vitePlatform: string): WindowPlatform {
    if (vitePlatform === "win32" || vitePlatform === "linux") return vitePlatform;
    return "other";
}

export function wantNativeDecorations(isNative: boolean, windowPlatform: WindowPlatform): boolean {
    return isNative || windowPlatform === "other";
}

export function renderTopBar(isNative: boolean, windowPlatform: WindowPlatform): boolean {
    if (windowPlatform === "linux") return !isNative;
    if (windowPlatform === "win32") return !isNative;
    return false;
}

/** Windows keeps the window library's own hit-testing, whose cursor shows there. */
export function renderResizeHandles(
    windowPlatform: WindowPlatform,
    showWindowControls: boolean,
): boolean {
    return windowPlatform === "linux" && showWindowControls;
}

export function buildAppMenuTree(args: {
    t: MenuTranslator;
    isMacOS: boolean;
    newTabShortcut: string;
    openFileShortcut: string;
    callbacks: AppMenuCallbacks;
}): MenuGroup[] {
    const { t, isMacOS, newTabShortcut, openFileShortcut, callbacks } = args;

    const aboutOption: MenuItemAction = {
        label: t("Menu.Help.About"),
        id: "about",
        action: callbacks.about,
    };

    const appMenu: MenuGroup = {
        label: t("Menu.Application.Menu"),
        options: [
            {
                label: t("Menu.Application.About", {
                    defaultValue: t("Menu.Help.About"),
                }),
                id: aboutOption.id,
                action: aboutOption.action,
            },
            { kind: "separator" },
            {
                label: `${t("SideBar.Settings")}${menuEllipsis}`,
                id: "settings",
                shortcut: "cmd+,",
                action: callbacks.openSettings,
            },
            {
                label: t("Menu.Application.Hide"),
                item: "Hide",
            },
            { kind: "separator" },
            {
                label: t("Menu.Application.Quit", {
                    defaultValue: t("Menu.File.Exit"),
                }),
                id: "quit",
                shortcut: "cmd+q",
                action: callbacks.exit,
            },
        ],
    };

    const macOSEditMenu: MenuGroup = {
        label: t("Menu.Edit"),
        options: [
            { label: t("Menu.Edit.Undo"), item: "Undo" },
            { label: t("Menu.Edit.Redo"), item: "Redo" },
            { kind: "separator" },
            { label: t("Menu.Edit.Copy"), item: "Copy" },
            { label: t("Menu.Edit.Cut"), item: "Cut" },
            { label: t("Menu.Edit.Paste"), item: "Paste" },
            { kind: "separator" },
            { label: t("Menu.Edit.SelectAll"), item: "SelectAll" },
        ],
    };

    return [
        ...(isMacOS ? [appMenu] : []),
        {
            label: t("Menu.File"),
            options: [
                {
                    label: t("Menu.File.NewTab"),
                    id: "new_tab",
                    shortcut: newTabShortcut,
                    action: callbacks.createNewTab,
                },
                {
                    label: t("Menu.File.OpenFile"),
                    id: "open_file",
                    shortcut: openFileShortcut,
                    action: callbacks.openNewFile,
                },
                ...(!isMacOS
                    ? [
                          {
                              label: t("Menu.File.Exit"),
                              id: "exit",
                              action: callbacks.exit,
                          },
                      ]
                    : []),
            ],
        },
        ...(!isMacOS ? [] : [macOSEditMenu]),
        {
            label: t("Menu.View"),
            options: [
                {
                    label: t("Menu.View.Reload"),
                    id: "reload",
                    shortcut: "Ctrl+R",
                    action: callbacks.reload,
                },
                {
                    label: t("Menu.View.Fullscreen"),
                    id: "toggle_fullscreen",
                    shortcut: isMacOS ? "Ctrl+Cmd+F" : "F11",
                    action: callbacks.toggleFullscreen,
                },
            ],
        },
        {
            label: t("Menu.Help"),
            options: [
                {
                    label: t("Menu.Help.SendFeedback"),
                    id: "send_feedback",
                    action: callbacks.sendFeedback,
                },
                {
                    label: t("Menu.Help.ClearSavedData"),
                    id: "clear_saved_data",
                    action: callbacks.clearSavedData,
                },
                {
                    label: t("Menu.Help.OpenLogs"),
                    id: "logs",
                    action: callbacks.openLogs,
                },
                { kind: "separator" },
                ...(!isMacOS ? [aboutOption] : []),
            ],
        },
    ];
}

export async function openPgnFromMenu<File>(deps: {
    pickPgnFile: () => Promise<File | null>;
    navigate: (opts: { to: string }) => void | Promise<unknown>;
    openFile: (file: File) => string | null | Promise<string | null>;
}): Promise<void> {
    const selected = await deps.pickPgnFile();
    if (!selected) return;
    const id = await deps.openFile(selected);
    if (id !== null) await deps.navigate({ to: "/" });
}

export async function createNewTabFromMenu(deps: {
    navigate: (opts: { to: string }) => void | Promise<unknown>;
    createTab: () => string | null | Promise<string | null>;
}): Promise<void> {
    const id = await deps.createTab();
    if (id !== null) await deps.navigate({ to: "/" });
}

export async function openSettingsFromMenu(deps: {
    navigate: (opts: { to: string }) => void | Promise<unknown>;
}): Promise<void> {
    await deps.navigate({ to: "/settings" });
}

export async function clearSavedDataFromMenu(deps: {
    ask: (message: string, options: { title: string }) => Promise<boolean>;
    confirmMessage: string;
    title: string;
    clear: () => void | Promise<void>;
}): Promise<void> {
    const confirmed = await deps.ask(deps.confirmMessage, { title: deps.title });
    if (confirmed) await deps.clear();
}

export async function runNativeMenuAction(
    command: () => Promise<unknown>,
    notify: (error: unknown) => void,
    successMessage?: string,
    showSuccess?: (message: string) => void,
): Promise<void> {
    try {
        await command();
        if (successMessage && showSuccess) showSuccess(successMessage);
    } catch (error) {
        const visible = errorUnlessCancelled(error);
        if (visible) notify(error);
    }
}

export async function runWindowAction(
    op: () => Promise<unknown>,
    notify: (error: unknown) => void,
): Promise<void> {
    await runNativeMenuAction(op, notify);
}

export type AppMenuCommandBindings = {
    runMenu: (command: () => Promise<unknown>, successMessage?: string) => Promise<void>;
    about: () => void;
    sendFeedback: () => void;
    createNewTab: () => Promise<unknown>;
    openNewFile: () => Promise<unknown>;
    openSettings: () => Promise<unknown>;
    exit: () => Promise<unknown>;
    reload: () => void;
    toggleFullscreen: () => Promise<unknown>;
    clearSavedData: () => Promise<unknown>;
    openLogs: () => Promise<unknown>;
    openLogsSuccessMessage?: string;
};

export function bindAppMenuCallbacks(bindings: AppMenuCommandBindings): AppMenuCallbacks {
    return {
        about: bindings.about,
        sendFeedback: bindings.sendFeedback,
        createNewTab: () => bindings.runMenu(bindings.createNewTab),
        openNewFile: () => bindings.runMenu(bindings.openNewFile),
        openSettings: () => bindings.runMenu(bindings.openSettings),
        exit: () => bindings.runMenu(bindings.exit),
        reload: bindings.reload,
        toggleFullscreen: () => bindings.runMenu(bindings.toggleFullscreen),
        clearSavedData: () => bindings.runMenu(bindings.clearSavedData),
        openLogs: () => bindings.runMenu(bindings.openLogs, bindings.openLogsSuccessMessage),
    };
}

export type WindowControlOps = {
    minimize: () => Promise<unknown>;
    toggleMaximize: () => Promise<unknown>;
    close: () => Promise<unknown>;
};

export type WindowControlHandlers = {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
};

export function bindWindowControls(
    appWindow: WindowControlOps,
    notify: (error: unknown) => void,
): WindowControlHandlers {
    return {
        minimize: () => runWindowAction(() => appWindow.minimize(), notify),
        toggleMaximize: () => runWindowAction(() => appWindow.toggleMaximize(), notify),
        close: () => runWindowAction(() => appWindow.close(), notify),
    };
}

export type MenuHandle = {
    setAsAppMenu: () => Promise<MenuHandle | null>;
    close: () => Promise<void>;
};

export type NativeMenuResource = {
    close: () => Promise<void>;
};

export type NativeMenuPredefinedOption = MenuItemAction & {
    item: NonNullable<MenuItemAction["item"]>;
};

export type NativeMenuFactories<T extends NativeMenuResource> = {
    separator: () => Promise<T>;
    predefined: (option: NativeMenuPredefinedOption) => Promise<T>;
    item: (option: MenuItemAction) => Promise<T>;
    submenu: (label: string, items: T[]) => Promise<T>;
    menu: (items: T[]) => Promise<T>;
};

async function closeCreated<T extends NativeMenuResource>(created: T[]): Promise<void> {
    for (const resource of created) {
        try {
            await resource.close();
        } catch {
            // Partial construction: close whatever already exists.
        }
    }
}

export async function assembleNativeMenuResources<T extends NativeMenuResource>(
    groups: MenuGroup[],
    factories: NativeMenuFactories<T>,
): Promise<T> {
    const created: T[] = [];
    try {
        const submenus: T[] = [];
        for (const group of groups) {
            const items: T[] = [];
            for (const option of group.options) {
                const resource =
                    "kind" in option
                        ? await factories.separator()
                        : option.item
                          ? await factories.predefined(option as NativeMenuPredefinedOption)
                          : await factories.item(option);
                created.push(resource);
                items.push(resource);
            }
            const submenu = await factories.submenu(group.label, items);
            created.push(submenu);
            submenus.push(submenu);
        }
        const menu = await factories.menu(submenus);
        created.push(menu);
        return menu;
    } catch (error) {
        await closeCreated(created);
        throw error;
    }
}

export type InstallAppMenuSurfaceArgs = {
    groups: MenuGroup[];
    wantRealMenu: boolean;
    wantDecorations: boolean;
    previousDecorationsApplied: boolean;
    isCurrent: () => boolean;
    createMenu: (groups: MenuGroup[]) => Promise<MenuHandle>;
    setDecorations: (on: boolean) => Promise<void>;
    closeMenu: (menu: MenuHandle) => Promise<void>;
    notify: (error: unknown) => void;
};

export type InstallAppMenuSurfaceResult = {
    decorationsApplied: boolean;
};

let installChain: Promise<void> = Promise.resolve();

export function resetInstallChainForTests(): void {
    installChain = Promise.resolve();
}

async function closeQuietly(
    closeMenu: (menu: MenuHandle) => Promise<void>,
    menu: MenuHandle | null | undefined,
): Promise<void> {
    if (!menu) return;
    try {
        await closeMenu(menu);
    } catch {
        // Closing a replaced menu is best-effort; a close failure must not
        // surface as the user's install error.
    }
}

async function installOnce(args: InstallAppMenuSurfaceArgs): Promise<InstallAppMenuSurfaceResult> {
    const previous = args.previousDecorationsApplied;
    let created: MenuHandle | undefined;
    try {
        if (!args.isCurrent()) return { decorationsApplied: previous };

        created = await args.createMenu(args.wantRealMenu ? args.groups : []);
        if (!args.isCurrent()) {
            await closeQuietly(args.closeMenu, created);
            return { decorationsApplied: previous };
        }

        let previousMenu: MenuHandle | null = null;
        try {
            previousMenu = await created.setAsAppMenu();
        } catch (error) {
            await closeQuietly(args.closeMenu, created);
            if (args.isCurrent()) args.notify(error);
            return { decorationsApplied: previous };
        }
        await closeQuietly(args.closeMenu, previousMenu);
        if (!args.isCurrent()) return { decorationsApplied: previous };

        try {
            await args.setDecorations(args.wantDecorations);
        } catch (error) {
            if (args.isCurrent()) args.notify(error);
            return { decorationsApplied: previous };
        }
        if (!args.isCurrent()) return { decorationsApplied: previous };

        return { decorationsApplied: args.wantDecorations };
    } catch (error) {
        await closeQuietly(args.closeMenu, created);
        if (args.isCurrent()) args.notify(error);
        return { decorationsApplied: previous };
    }
}

export async function installAppMenuSurface(
    args: InstallAppMenuSurfaceArgs,
): Promise<InstallAppMenuSurfaceResult> {
    let result: InstallAppMenuSurfaceResult = {
        decorationsApplied: args.previousDecorationsApplied,
    };
    const run = async () => {
        result = await installOnce(args);
    };
    const next = installChain.then(run, run);
    installChain = next.then(
        () => undefined,
        () => undefined,
    );
    await next;
    return result;
}

export function watchMaximized(options: {
    isMaximized: () => Promise<boolean>;
    onResized: (handler: () => void) => Promise<() => void> | (() => void);
    setMaximized: (value: boolean) => void;
    notify: (error: unknown) => void;
}): () => void {
    const lifecycle = createNativeListenerLifecycle({
        onFailure: (error) => {
            const visible = errorUnlessCancelled(error);
            if (visible) options.notify(error);
        },
        stopOnFailure: true,
    });

    let checkSeq = 0;
    const check = async () => {
        const seq = ++checkSeq;
        if (lifecycle.isStopped()) return;
        try {
            const maximized = await options.isMaximized();
            if (lifecycle.isStopped() || seq !== checkSeq) return;
            options.setMaximized(maximized);
        } catch (error) {
            if (lifecycle.isStopped() || seq !== checkSeq) return;
            lifecycle.fail(error);
        }
    };

    void check();
    lifecycle.attach(() =>
        options.onResized(() => {
            void check();
        }),
    );

    return () => lifecycle.stop();
}
