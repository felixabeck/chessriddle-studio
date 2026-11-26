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
    openGuide: () => void | Promise<void>;
    openAssistant?: () => void;
    createNewTab: () => void | Promise<void>;
    openNewFile: () => void | Promise<void>;
    saveGame: () => void | Promise<void>;
    saveGameTo: () => void | Promise<void>;
    openAccounts: () => void | Promise<void>;
    openEngines: () => void | Promise<void>;
    openSettings: () => void | Promise<void>;
    exit: () => void | Promise<void>;
    toggleFullscreen: () => void | Promise<void>;
    toggleFocusMode: () => void;
};

/** Focus mode hides the navigation row; the View entry's label says what choosing it does. */
export type FocusModeMenuState = { on: boolean; shortcut: string };

export type WindowPlatform = "win32" | "linux" | "other";

const menuEllipsis = String.fromCodePoint(0x2026);

export function menuWindowPlatform(vitePlatform: string): WindowPlatform {
    if (vitePlatform === "win32" || vitePlatform === "linux") return vitePlatform;
    return "other";
}

/** Full-screen shortcut. The native macOS menu registers it as its accelerator; Linux and Windows bind F11 in the renderer. */
export function fullscreenShortcut(isMacOS: boolean): string {
    return isMacOS ? "Ctrl+Cmd+F" : "F11";
}

/** The View entries, shared by the macOS View menu and the in-app menu. */
function viewMenuOptions(
    t: MenuTranslator,
    isMacOS: boolean,
    focusMode: FocusModeMenuState,
    callbacks: AppMenuCallbacks,
): MenuItemAction[] {
    return [
        {
            label: t("Menu.View.Fullscreen"),
            id: "toggle_fullscreen",
            shortcut: fullscreenShortcut(isMacOS),
            action: callbacks.toggleFullscreen,
        },
        {
            label: t(focusMode.on ? "Menu.View.ShowHeader" : "Menu.View.HideHeader"),
            id: "toggle_focus_mode",
            shortcut: focusMode.shortcut,
            action: callbacks.toggleFocusMode,
        },
    ];
}

export function wantNativeDecorations(isNative: boolean, windowPlatform: WindowPlatform): boolean {
    return isNative || windowPlatform === "other";
}

/** Native application menu is macOS only. Linux and Windows use the row's menu button in both decoration modes. */
export function wantRealMenu(windowPlatform: WindowPlatform): boolean {
    return windowPlatform === "other";
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
    showAssistant?: boolean;
    newTabShortcut: string;
    openFileShortcut: string;
    saveShortcut: string;
    focusMode: FocusModeMenuState;
    callbacks: AppMenuCallbacks;
}): MenuGroup[] {
    const {
        t,
        isMacOS,
        showAssistant = false,
        newTabShortcut,
        openFileShortcut,
        saveShortcut,
        focusMode,
        callbacks,
    } = args;

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
                { kind: "separator" },
                {
                    label: t("Common.Save"),
                    id: "save",
                    shortcut: saveShortcut,
                    action: callbacks.saveGame,
                },
                {
                    label: t("Board.Database.Save"),
                    id: "save_to",
                    action: callbacks.saveGameTo,
                },
                ...(!isMacOS
                    ? [
                          { kind: "separator" as const },
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
            options: viewMenuOptions(t, isMacOS, focusMode, callbacks),
        },
        {
            label: t("Menu.Help"),
            options: [
                {
                    label: t("Menu.Help.Guide"),
                    id: "guide",
                    action: callbacks.openGuide,
                },
                ...(showAssistant
                    ? [
                          {
                              label: t("Menu.Help.Assistant"),
                              id: "assistant",
                              action: callbacks.openAssistant,
                          },
                      ]
                    : []),
                {
                    label: t("Menu.Help.SendFeedback"),
                    id: "send_feedback",
                    action: callbacks.sendFeedback,
                },
                ...(!isMacOS ? [{ kind: "separator" as const }, aboutOption] : []),
            ],
        },
    ];
}

export function buildInAppMenuItems(args: {
    t: MenuTranslator;
    isMacOS: boolean;
    showAssistant?: boolean;
    newTabShortcut: string;
    openFileShortcut: string;
    saveShortcut: string;
    focusMode: FocusModeMenuState;
    callbacks: AppMenuCallbacks;
}): MenuAction[] {
    const {
        t,
        isMacOS,
        showAssistant = false,
        newTabShortcut,
        openFileShortcut,
        saveShortcut,
        focusMode,
        callbacks,
    } = args;
    return [
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
        { kind: "separator" },
        {
            label: t("Common.Save"),
            id: "save",
            shortcut: saveShortcut,
            action: callbacks.saveGame,
        },
        {
            label: t("Board.Database.Save"),
            id: "save_to",
            action: callbacks.saveGameTo,
        },
        { kind: "separator" },
        {
            label: t("SideBar.Accounts"),
            id: "accounts",
            action: callbacks.openAccounts,
        },
        {
            label: t("SideBar.Engines"),
            id: "engines",
            action: callbacks.openEngines,
        },
        {
            label: t("SideBar.Settings"),
            id: "settings",
            action: callbacks.openSettings,
        },
        { kind: "separator" },
        ...viewMenuOptions(t, isMacOS, focusMode, callbacks),
        { kind: "separator" },
        {
            label: t("Menu.Help.Guide"),
            id: "guide",
            action: callbacks.openGuide,
        },
        ...(showAssistant
            ? [
                  {
                      label: t("Menu.Help.Assistant"),
                      id: "assistant",
                      action: callbacks.openAssistant,
                  },
              ]
            : []),
        {
            label: t("Menu.Help.SendFeedback"),
            id: "send_feedback",
            action: callbacks.sendFeedback,
        },
        {
            label: t("Menu.Help.About"),
            id: "about",
            action: callbacks.about,
        },
        ...(!isMacOS
            ? [
                  { kind: "separator" as const },
                  {
                      label: t("Menu.File.Exit"),
                      id: "exit",
                      action: callbacks.exit,
                  },
              ]
            : []),
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

export type MenuPagePath = "/settings" | "/accounts" | "/engines" | "/guide";

export async function openPageFromMenu(deps: {
    navigate: (opts: { to: string }) => void | Promise<unknown>;
    to: MenuPagePath;
}): Promise<void> {
    await deps.navigate({ to: deps.to });
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
    openGuide: () => Promise<unknown>;
    openAssistant?: () => void;
    createNewTab: () => Promise<unknown> | void;
    openNewFile: () => Promise<unknown>;
    saveGame: () => Promise<unknown>;
    saveGameTo: () => Promise<unknown>;
    openAccounts: () => Promise<unknown>;
    openEngines: () => Promise<unknown>;
    openSettings: () => Promise<unknown>;
    exit: () => Promise<unknown>;
    toggleFullscreen: () => Promise<unknown>;
    toggleFocusMode: () => void;
};

export function bindAppMenuCallbacks(bindings: AppMenuCommandBindings): AppMenuCallbacks {
    return {
        about: bindings.about,
        sendFeedback: bindings.sendFeedback,
        openGuide: () => bindings.runMenu(bindings.openGuide),
        ...(bindings.openAssistant ? { openAssistant: bindings.openAssistant } : {}),
        createNewTab: () => bindings.runMenu(async () => bindings.createNewTab()),
        openNewFile: () => bindings.runMenu(bindings.openNewFile),
        saveGame: () => bindings.runMenu(bindings.saveGame),
        saveGameTo: () => bindings.runMenu(bindings.saveGameTo),
        openAccounts: () => bindings.runMenu(bindings.openAccounts),
        openEngines: () => bindings.runMenu(bindings.openEngines),
        openSettings: () => bindings.runMenu(bindings.openSettings),
        exit: () => bindings.runMenu(bindings.exit),
        toggleFullscreen: () => bindings.runMenu(bindings.toggleFullscreen),
        toggleFocusMode: bindings.toggleFocusMode,
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
