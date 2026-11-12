/** The only renderer module that imports Tauri plugin and API runtime values. */
export { getTauriVersion, getVersion } from "@tauri-apps/api/app";
export { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
export { getCurrentWebviewWindow, type WebviewWindow } from "@tauri-apps/api/webviewWindow";
export { getCurrentWindow } from "@tauri-apps/api/window";
export { getMatches } from "@tauri-apps/plugin-cli";
export { ask } from "@tauri-apps/plugin-dialog";
export { error, info, warn } from "@tauri-apps/plugin-log";
export {
    arch,
    platform,
    type Platform,
    type as osType,
    version as OSVersion,
} from "@tauri-apps/plugin-os";
export { exit, relaunch } from "@tauri-apps/plugin-process";
export { check, type Update } from "@tauri-apps/plugin-updater";
