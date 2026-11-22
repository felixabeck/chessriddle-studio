/** The file workspace and download-destination capabilities. */
import { atomWithStorage } from "jotai/utils";
import { z } from "zod";
import type { FileWorkspaceHandle, PathRef } from "@/bindings";
import { fileWorkspaceHandleSchema, pathRefSchema } from "../../utils/pathCapabilities";
import { createZodStorage } from "../utils";
import { createExpandedDirectoriesAtom } from "../expandedDirectories";
import { documentPreferences } from "./rendererState";

// Legacy builds stored a renderer-visible document directory. It is deliberately
// scrubbed instead of migrated: only the native-issued opaque workspace survives.
// A native-issued, DownloadFile-only path capability.  Unlike the legacy directory settings it
// is opaque and never serializes a physical filesystem location into renderer storage.
export const downloadDestinationAtom = documentPreferences.atomWithStorage<PathRef | null>(
    "download-destination-capability",
    null,
    createZodStorage(pathRefSchema.nullable(), localStorage),
);
export const fileWorkspaceAtom = documentPreferences.atomWithStorage<FileWorkspaceHandle | null>(
    "file-workspace",
    null,
    createZodStorage(fileWorkspaceHandleSchema.nullable(), localStorage),
);
export const expandedDirectoriesAtom = createExpandedDirectoriesAtom(
    fileWorkspaceAtom,
    sessionStorage,
);
/** Display metadata only; authority remains exclusively in fileWorkspaceAtom. */
export const fileWorkspaceDisplayNameAtom = atomWithStorage<string>(
    "file-workspace-display-name",
    "",
    createZodStorage(z.string().max(256), localStorage),
);
