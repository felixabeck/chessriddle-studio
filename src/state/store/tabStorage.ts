import { warnSafely } from "@/platform/errors";
import { ANNOTATION_INFO, MAX_NAG } from "@/utils/annotation";
import { reportPersistError } from "@/state/persistError";
import { puzzleSessionSchema } from "@/state/puzzleSession";
import { splitPgnComment } from "@/utils/pgnComment";
import { extractPgnDrawings, toDrawShape, type PgnDrawing } from "@/utils/drawings";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { getResolvedPathLength, type TreeState } from "@/utils/treeReducer";
import { z } from "zod";
import { linkedGameLocatorSchema } from "@/utils/pathCapabilities";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { decodeCompressedOrJson, serializeStorageValue } from "./debouncedStorage";

export const TREE_STORAGE_VERSION = 1;
const DEBOUNCE_MS = 300;
const FAILED_ADMISSION_PREFIX = "chessfable:failed-tab-admission:";
const FAILED_ADMISSION_VALUE = "1";
// Legacy tabs could use arbitrary IDs, including keys now owned by other stores.
const NON_TREE_SESSION_KEYS = new Set([
    "workspace",
    "tabs",
    "activeTab",
    "database-view",
    "expanded-directories",
]);
const MAX_TREE_NODES = 100_000;
const MAX_TREE_DEPTH = 512;
const MAX_NODE_NAGS = 1_024;
const MAX_SHAPE_BRUSH_LENGTH = 64;
const MAX_NODE_SHAPES = 10_000;
export const MAX_STORE_ATTEMPTS = 100;
const MAX_STORE_DESTINATION_LENGTH = 256;
// Tree text comes out of a lexed PGN, which the backend caps at 10 MiB (`validate_pgn_len`), and
// no parsed string — a header, a comment, its commands — is longer than its source. So any parsed
// tree rehydrates; a lower bound once made a tab with one long comment unreadable.
export const PGN_TEXT_MAX = 10 * 1024 * 1024;
/** A game stamp is the lowercase hex SHA-256 of the game's exact bytes (`read_game`). */
const STAMP_PATTERN = /^[a-f0-9]{64}$/;

export function createTabIdSchema() {
    return z.string().uuid();
}

function createLegacyAnnotationsSchema() {
    return z
        .array(
            z.enum([
                "",
                "!",
                "!!",
                "?",
                "??",
                "!?",
                "?!",
                "+-",
                "±",
                "⩲",
                "=",
                "∞",
                "⩱",
                "∓",
                "-+",
                "N",
                "↑↑",
                "↑",
                "→",
                "⇆",
                "=∞",
                "⊕",
                "∆",
                "□",
                "⨀",
                "⊗",
            ]),
        )
        .max(MAX_NODE_NAGS);
}

function createPersistedTreeSchema() {
    const boundedText = z.string().max(PGN_TEXT_MAX);
    const pathSchema = z.array(z.number().int().nonnegative()).max(MAX_TREE_DEPTH);
    const scoreSchema = z.object({
        value: z.discriminatedUnion("type", [
            z.object({ type: z.literal("cp"), value: z.number().finite() }),
            z.object({ type: z.literal("mate"), value: z.number().int() }),
        ]),
        wdl: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).nullable(),
    });
    const roleSchema = z.enum(["pawn", "knight", "bishop", "rook", "queen", "king"]);
    const boardSquareSchema = z
        .number()
        .int()
        .refine((square) => square >= 0 && square <= 63);
    const moveSchema = z.union([
        z.object({
            from: boardSquareSchema,
            to: boardSquareSchema,
            promotion: roleSchema.optional(),
        }),
        z.object({ role: roleSchema, to: boardSquareSchema }),
    ]);
    const shapeSchema = z.object({
        orig: z.string().regex(/^[a-h][1-8]$/),
        dest: z
            .string()
            .regex(/^[a-h][1-8]$/)
            .optional(),
        brush: z.string().max(MAX_SHAPE_BRUSH_LENGTH),
        modifiers: z
            .object({
                lineWidth: z.number().finite().optional(),
                opacity: z.number().finite().optional(),
            })
            .optional(),
    });
    const headersSchema = z.object({
        id: z.number().int(),
        fen: boundedText,
        event: boundedText,
        site: boundedText,
        date: boundedText.nullable().optional(),
        time: boundedText.nullable().optional(),
        round: boundedText.nullable().optional(),
        white: boundedText,
        white_elo: z.number().int().nullable().optional(),
        black: boundedText,
        black_elo: z.number().int().nullable().optional(),
        result: z.enum(["1-0", "0-1", "1/2-1/2", "*"]),
        time_control: boundedText.nullable().optional(),
        white_time_control: boundedText.nullable().optional(),
        black_time_control: boundedText.nullable().optional(),
        eco: boundedText.nullable().optional(),
        variant: boundedText.nullable().optional(),
        other: z.record(boundedText).optional(),
        start: pathSchema.optional(),
        orientation: z
            .string()
            .refine((orientation) => orientation === "white" || orientation === "black")
            .optional(),
    });

    type PersistedTreeNode = {
        fen: string;
        move:
            | { from: number; to: number; promotion?: z.infer<typeof roleSchema> }
            | { role: z.infer<typeof roleSchema>; to: number }
            | null;
        san: string | null;
        children: PersistedTreeNode[];
        score: {
            value: { type: "cp"; value: number } | { type: "mate"; value: number };
            wdl: [number, number, number] | null;
        } | null;
        depth: number | null;
        halfMoves: number;
        shapes: Array<{
            orig: string;
            dest?: string;
            brush: string;
            modifiers?: { lineWidth?: number; opacity?: number };
        }>;
        nags: number[];
        comment: string;
        commands?: string;
        startingComment?: string;
        clock?: number;
    };

    const treeNodeSchema: z.ZodType<PersistedTreeNode> = z.lazy(() => treeNodeObjectSchema);
    const treeNodeObjectSchema = z.object({
        fen: boundedText,
        move: moveSchema.nullable(),
        san: boundedText.nullable(),
        children: z.array(treeNodeSchema).max(MAX_TREE_NODES),
        score: scoreSchema.nullable(),
        depth: z.number().int().nonnegative().nullable(),
        halfMoves: z.number().int().nonnegative(),
        shapes: z.array(shapeSchema).max(MAX_NODE_SHAPES),
        nags: z.array(z.number().int().min(0).max(MAX_NAG)).max(MAX_NODE_NAGS),
        comment: boundedText,
        commands: boundedText.optional(),
        startingComment: boundedText.optional(),
        clock: z.number().finite().optional(),
    });

    return z.object({
        root: treeNodeSchema,
        headers: headersSchema,
        position: pathSchema,
        dirty: z.boolean(),
        sourceStamp: z.string().regex(STAMP_PATTERN).nullable(),
        linkedSource: linkedGameLocatorSchema.nullable().optional(),
        appendAttempted: z.boolean(),
        storeAttempts: z
            .array(z.string().min(1).max(MAX_STORE_DESTINATION_LENGTH))
            .max(MAX_STORE_ATTEMPTS)
            .optional(),
        report: z.object({
            inProgress: z.boolean(),
            operationId: z.string().nullable().optional(),
        }),
        practicePath: pathSchema.nullable().optional(),
        puzzleSession: puzzleSessionSchema.optional(),
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fast preflight for untrusted storage before recursive Zod parsing. */
export function isBoundedTreeForStorage(value: unknown): boolean {
    let nodes = 0;
    const visit = (node: unknown, depth: number): boolean => {
        if (!isRecord(node) || depth > MAX_TREE_DEPTH || ++nodes > MAX_TREE_NODES) return false;
        // Zod owns structural validation. This preflight only bounds recursive work.
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                if (!visit(child, depth + 1)) return false;
            }
        }
        return true;
    };
    return isRecord(value) && visit(value.root, 0);
}

function migrateReport(report: unknown): { inProgress: boolean; operationId: string | null } {
    if (!isRecord(report)) {
        return { inProgress: false, operationId: null };
    }
    return {
        inProgress: typeof report.inProgress === "boolean" ? report.inProgress : false,
        // Coerce a wrong-typed id to null: Zod would otherwise reject the whole tree.
        operationId: typeof report.operationId === "string" ? report.operationId : null,
    };
}

/**
 * Migrates legacy node fields in one bounded walk. Before commands were split out of comments
 * (c449fbb2), trees carried `[%…]` commands inside `comment` and no `commands` field.
 * Split those once. Current prose stays untouched, while opaque drawing commands can acquire
 * newly supported shapes. Consumed entries leave commands, making repeated reads idempotent.
 * Depth is bounded like the schema's recursion.
 * Legacy glyph arrays become canonical NAG codes, preserving their order and multiplicity.
 * The empty glyph has lost its code already; invalid legacy glyphs remain unreadable.
 */
function migrateLegacyNode(
    node: unknown,
    legacyAnnotationsSchema: ReturnType<typeof createLegacyAnnotationsSchema>,
    depth = 0,
): unknown {
    if (!isRecord(node) || depth > MAX_TREE_DEPTH) return node;
    const migrated: Record<string, unknown> = { ...node };
    if (!Object.prototype.hasOwnProperty.call(node, "nags") && Array.isArray(node.annotations)) {
        const legacy = legacyAnnotationsSchema.safeParse(node.annotations);
        if (legacy.success) {
            migrated.nags = legacy.data
                .filter((glyph) => glyph !== "")
                .map((glyph) => ANNOTATION_INFO[glyph].nag);
            delete migrated.annotations;
        }
    }
    if (Array.isArray(node.children)) {
        migrated.children = node.children.map((child) =>
            migrateLegacyNode(child, legacyAnnotationsSchema, depth + 1),
        );
    }
    if (
        !Object.prototype.hasOwnProperty.call(node, "commands") &&
        typeof node.comment === "string"
    ) {
        const { text, commands, shapes } = splitPgnComment(node.comment);
        migrated.comment = text;
        if (commands.length > 0) migrated.commands = commands;
        retainHydratedDrawings(migrated, shapes);
    } else if (typeof node.commands === "string") {
        const { text, shapes } = extractPgnDrawings(node.commands);
        if (shapes.length > 0) {
            migrated.commands = text.trim();
            retainHydratedDrawings(migrated, shapes);
        }
    }
    return migrated;
}

/** Consume existing matches as a multiset, preserving deliberate duplicates in either source. */
function retainHydratedDrawings(node: Record<string, unknown>, drawings: PgnDrawing[]): void {
    // Never repair an invalid shapes field. The storage schema must still refuse it.
    if (!Array.isArray(node.shapes)) return;
    const identity = (shape: DrawShape) =>
        `${shape.orig}:${shape.dest ?? shape.orig}:${shape.brush}`;
    const counts = new Map<string, number>();
    for (const shape of node.shapes) {
        if (!isRecord(shape)) continue;
        const key = identity(shape as unknown as DrawShape);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const added: DrawShape[] = [];
    for (const drawing of drawings) {
        const shape = toDrawShape(drawing);
        const key = identity(shape);
        const remaining = counts.get(key) ?? 0;
        if (remaining > 0) counts.set(key, remaining - 1);
        else added.push(shape);
    }
    node.shapes = [...node.shapes, ...added];
}

/** Adds fields that were absent before TreeState persistence was versioned. */
export function migrateTreeForStorage(value: unknown): unknown {
    if (!isRecord(value)) return value;
    const legacyAnnotationsSchema = createLegacyAnnotationsSchema();
    const hasAppendAttempted = Object.prototype.hasOwnProperty.call(value, "appendAttempted");
    return {
        ...value,
        // An absent source remains a valid pre-collection tree. Present locators are validated
        // with the current schema before the tree is admitted.
        root: migrateLegacyNode(value.root, legacyAnnotationsSchema),
        position: Array.isArray(value.position) ? value.position : [],
        dirty: typeof value.dirty === "boolean" ? value.dirty : false,
        sourceStamp:
            typeof value.sourceStamp === "string" && STAMP_PATTERN.test(value.sourceStamp)
                ? value.sourceStamp
                : null,
        appendAttempted:
            typeof value.appendAttempted === "boolean" ? value.appendAttempted : hasAppendAttempted,
        report: migrateReport(value.report),
    };
}

type StoredTree = StorageValue<unknown>;
type ValidatedStoredTree = StorageValue<z.infer<ReturnType<typeof createPersistedTreeSchema>>>;

export type TabTreeStorageStatus =
    | { kind: "not-read" }
    | { kind: "absent" }
    | { kind: "available" }
    | { kind: "unreadable"; rawValue: string }
    | { kind: "unavailable"; error: unknown };

export type TabTreeReadResult =
    | { kind: "absent" }
    | { kind: "available"; value: StoredTree }
    | { kind: "unreadable"; rawValue: string }
    | { kind: "unavailable"; error: unknown };

export type TabTreeCloneResult =
    | { kind: "copied" }
    | Exclude<TabTreeReadResult, { kind: "available" }>
    | { kind: "copy-failed"; error: unknown };

const NOT_READ_STATUS: TabTreeStorageStatus = { kind: "not-read" };

function parseTree(value: unknown): ValidatedStoredTree | null {
    const candidate = migrateTreeForStorage(value);
    if (!isBoundedTreeForStorage(candidate)) return null;
    const parsed = createPersistedTreeSchema().safeParse(candidate);
    if (!parsed.success) return null;

    // A stored path is repaired against the tree it was stored with: the cursor and the drill path
    // clamp to their longest resolving prefix, and an unresolvable repertoire start is dropped.
    const state = parsed.data;
    state.position = state.position.slice(0, getResolvedPathLength(state.root, state.position));
    const { start } = state.headers;
    if (start !== undefined && getResolvedPathLength(state.root, start) !== start.length) {
        delete state.headers.start;
    }
    const { practicePath } = state;
    if (practicePath !== undefined && practicePath !== null) {
        state.practicePath = practicePath.slice(0, getResolvedPathLength(state.root, practicePath));
    }

    return { version: TREE_STORAGE_VERSION, state };
}

/** The read gate as a predicate: whether this tree state would rehydrate if it were stored. */
export function canRehydrate(state: unknown): boolean {
    return parseTree(state) !== null;
}

/** Admission installs the same canonical paths and fields that a fresh reader will restore. */
export function prepareTreeForStorage(state: unknown): TreeState {
    const value = parseTree(state);
    if (!value) throw new Error("Cannot persist an invalid game tree.");
    return value.state as TreeState;
}

export function createTabStorageQuotaError(cause: unknown): Error {
    return new Error(
        "Could not open the game: the browser's session storage is full. Close some open tabs and try again.",
        { cause },
    );
}

export function persistStorageWriteError(cause: unknown): Error {
    if (
        typeof cause === "object" &&
        cause !== null &&
        "name" in cause &&
        String((cause as { name: unknown }).name) === "QuotaExceededError"
    ) {
        return createTabStorageQuotaError(cause);
    }
    // jsdom's DOMException is not an Error; the browser one is, so the first arm covers WebKit.
    if (cause instanceof Error || cause instanceof DOMException) return cause;
    return new Error("Could not save this game. Session storage rejected the write.", { cause });
}

export function decodeLegacyOrCompressed(value: string): ValidatedStoredTree | null {
    const decoded = decodeCompressedOrJson(value);
    const envelope = z
        .object({ version: z.number().int().nonnegative(), state: z.unknown() })
        .safeParse(decoded);
    if (envelope.success) return parseTree(envelope.data.state);

    // The earliest sessions stored TreeState itself as plain JSON, without the
    // zustand envelope or compression. Keep that recovery path deliberately
    // narrow so corrupt blobs are retained for explicit recovery rather than trusted.
    return parseTree(decoded);
}

/**
 * The sole owner of tab-tree storage. In particular, callers never read
 * sessionStorage directly: a clone or close observes not-yet-flushed edits.
 */
export class TabStorageRepository {
    private readonly pending = new Map<string, StoredTree>();
    private readonly readStatuses = new Map<string, TabTreeStorageStatus>();
    private readonly statusListeners = new Map<string, Set<() => void>>();
    private flushTimeout: ReturnType<typeof setTimeout> | null = null;
    private handlersBound = false;

    storageFor<S>(requireExisting = false): PersistStorage<S> {
        return {
            getItem: (name) => this.read<S>(name, requireExisting),
            setItem: (name, value) => {
                this.write(name, value);
            },
            removeItem: (name) => this.remove(name),
        };
    }

    read<S>(tabId: string, requireExisting = false): StorageValue<S> | null {
        const result = this.readTree(tabId, requireExisting);
        return result.kind === "available" ? (result.value as StorageValue<S>) : null;
    }

    /** Read the exact tab key while keeping unreadable and refused reads distinct from absence. */
    readTree(tabId: string, requireExisting = false): TabTreeReadResult {
        return this.readTreeValue(tabId, {
            requireExisting,
            migrate: true,
            recordStatus: true,
        });
    }

    /**
     * Read-only tree inspection: pending frame first, no migration write, getStatus unchanged.
     * Unreadable and unavailable stay distinct from absent; requireExisting treats a missing key
     * as unavailable.
     */
    inspectTree(tabId: string, requireExisting = false): TabTreeReadResult {
        return this.readTreeValue(tabId, {
            requireExisting,
            migrate: false,
            recordStatus: false,
        });
    }

    private readTreeValue(
        tabId: string,
        options: {
            requireExisting: boolean;
            migrate: boolean;
            recordStatus?: boolean;
        },
    ): TabTreeReadResult {
        const { requireExisting, migrate, recordStatus = true } = options;
        const finish = (result: TabTreeReadResult): TabTreeReadResult => {
            if (recordStatus) {
                this.setReadStatus(
                    tabId,
                    result.kind === "available" ? { kind: "available" } : result,
                );
            }
            return result;
        };

        const pending = this.pending.get(tabId);
        if (pending) {
            return finish({ kind: "available", value: pending });
        }
        if (NON_TREE_SESSION_KEYS.has(tabId)) {
            return finish({ kind: "absent" });
        }

        let raw: string | null;
        try {
            raw = sessionStorage.getItem(tabId);
        } catch (error) {
            return finish({ kind: "unavailable", error });
        }
        if (raw === null) {
            return finish(
                requireExisting
                    ? {
                          kind: "unavailable",
                          error: new Error("The referenced game tree is missing."),
                      }
                    : { kind: "absent" },
            );
        }

        const decoded = decodeLegacyOrCompressed(raw);
        if (!decoded) {
            return finish({ kind: "unreadable", rawValue: raw });
        }

        // When migrating, both an old uncompressed JSON payload and a former v0
        // envelope are rewritten immediately, before the next debounced store update.
        // Non-migrating readers such as inspectTree leave the stored bytes unchanged.
        if (migrate && raw !== serializeStorageValue(decoded)) {
            try {
                sessionStorage.setItem(tabId, serializeStorageValue(decoded));
            } catch (error) {
                warnSafely(`Could not migrate tree storage ${tabId}: ${String(error)}`);
            }
        }
        return finish({ kind: "available", value: decoded });
    }

    getStatus(tabId: string): TabTreeStorageStatus {
        return this.readStatuses.get(tabId) ?? NOT_READ_STATUS;
    }

    subscribeStatus(tabId: string, listener: () => void): () => void {
        const listeners = this.statusListeners.get(tabId) ?? new Set<() => void>();
        this.statusListeners.set(tabId, listeners);
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && this.statusListeners.get(tabId) === listeners) {
                this.statusListeners.delete(tabId);
            }
        };
    }

    /** Returns the exact undecodable bytes captured during hydration for explicit recovery. */
    readRawValueForRecovery(tabId: string): string {
        const status = this.getStatus(tabId);
        if (status.kind !== "unreadable") {
            throw new Error("This tab has no readable undecodable tree value to copy.");
        }
        return status.rawValue;
    }

    /** Removes only a known undecodable value, clearing its write gate after verified removal. */
    discardUnreadable(tabId: string): boolean {
        const status = this.getStatus(tabId);
        if (status.kind !== "unreadable") return false;
        try {
            sessionStorage.removeItem(tabId);
            if (sessionStorage.getItem(tabId) !== null) {
                throw new Error("Session storage retained the unreadable tree after removal.");
            }
        } catch (error) {
            const reported = persistStorageWriteError(error);
            reportPersistError(reported);
            throw reported;
        }
        this.pending.delete(tabId);
        this.setReadStatus(tabId, { kind: "absent" });
        return true;
    }

    write<S>(tabId: string, value: StorageValue<S>) {
        if (this.writeBlocker(tabId)) return;
        this.pending.set(tabId, { version: TREE_STORAGE_VERSION, state: value.state });
        this.setReadStatus(tabId, { kind: "available" });
        this.scheduleFlush();
    }

    seed(tabId: string, state: unknown) {
        const value = parseTree(state);
        if (!value) throw new Error("Cannot persist an invalid game tree.");
        const blocker = this.writeBlocker(tabId);
        if (blocker) {
            throw new Error(
                "Cannot replace a tab tree while its storage is unreadable or unavailable.",
                { cause: blocker.kind === "unavailable" ? blocker.error : blocker },
            );
        }
        try {
            sessionStorage.setItem(tabId, serializeStorageValue(value));
            // This complete durable frame supersedes every older debounced frame for this key.
            this.pending.delete(tabId);
            this.setReadStatus(tabId, { kind: "available" });
        } catch (error) {
            throw persistStorageWriteError(error);
        }
    }

    clone(sourceTabId: string, targetTabId: string, requireExisting = false): TabTreeCloneResult {
        const source = this.readTree(sourceTabId, requireExisting);
        if (source.kind !== "available") return source;
        const copy = this.validatedClone(source.value);
        if (!copy) {
            return {
                kind: "copy-failed",
                error: new Error("Could not validate the source tree."),
            };
        }
        const blocker = this.writeBlocker(targetTabId);
        if (blocker) {
            return {
                kind: "copy-failed",
                error:
                    blocker.kind === "unavailable"
                        ? blocker.error
                        : new Error("The destination tree key cannot be replaced."),
            };
        }
        this.pending.set(targetTabId, copy);
        this.setReadStatus(targetTabId, { kind: "available" });
        this.scheduleFlush();
        return { kind: "copied" };
    }

    /** Copies exact unreadable bytes to a fresh migration ID and verifies the durable target. */
    copyUnreadableForWorkspaceRepair(targetTabId: string, rawValue: string): void {
        if (NON_TREE_SESSION_KEYS.has(targetTabId)) {
            throw new Error("The destination key belongs to another session store.");
        }
        const target = this.readTree(targetTabId);
        if (target.kind !== "absent") {
            throw target.kind === "unavailable"
                ? target.error
                : new Error("The destination tree key is already in use.");
        }

        try {
            sessionStorage.setItem(targetTabId, rawValue);
            if (sessionStorage.getItem(targetTabId) !== rawValue) {
                throw new Error("Could not verify the copied unreadable tree value.");
            }
            this.setReadStatus(targetTabId, { kind: "unreadable", rawValue });
        } catch (error) {
            // The target was verified absent immediately before this write. Remove only bytes
            // produced by this copy; the original source remains the workspace's owner.
            let failure = error;
            try {
                if (sessionStorage.getItem(targetTabId) === rawValue) {
                    sessionStorage.removeItem(targetTabId);
                }
            } catch (cleanupError) {
                failure = cleanupError;
            }
            this.setReadStatus(targetTabId, { kind: "unavailable", error: failure });
            throw failure;
        }
    }

    /** Validated independent candidate without migrating, flushing or recovering the source. */
    readForClone(sourceTabId: string, requireExisting = false): TreeState | null {
        // A duplication read cannot recover the original cached store. Only explicit hydration
        // may release its existing gate, even when the underlying storage has become readable.
        const status = this.getStatus(sourceTabId);
        const source =
            status.kind === "unreadable" || status.kind === "unavailable"
                ? status
                : this.readTreeValue(sourceTabId, { requireExisting, migrate: false });
        if (source.kind === "absent") return null;
        if (source.kind === "unavailable") {
            throw new Error("Could not read the source tree for duplication.", {
                cause: source.error,
            });
        }
        if (source.kind === "unreadable") {
            throw new Error("Cannot duplicate a tab whose saved tree is unreadable.");
        }
        const copy = this.validatedClone(source.value);
        if (!copy) throw new Error("Could not validate the source tree for duplication.");
        return copy.state as TreeState;
    }

    /** Creates an immediately durable clone without flushing any unrelated pending tree. */
    cloneDurable(sourceTabId: string, targetTabId: string, requireExisting = false) {
        const copy = this.readForClone(sourceTabId, requireExisting);
        if (copy) this.seed(targetTabId, copy);
    }

    remove(tabId: string) {
        this.pending.delete(tabId);
        sessionStorage.removeItem(tabId);
        this.setReadStatus(tabId, NOT_READ_STATUS);
    }

    /** Removes a known tree without letting cleanup failures abort its owning operation. */
    removeTreeSafely(tabId: string) {
        return !this.removeKnownTreesSafely([tabId]).has(tabId);
    }

    /** A refused admission records the exact tree to retry when rollback removal failed. */
    recordFailedAdmission(tabId: string) {
        try {
            sessionStorage.setItem(`${FAILED_ADMISSION_PREFIX}${tabId}`, FAILED_ADMISSION_VALUE);
        } catch (error) {
            reportPersistError(persistStorageWriteError(error));
        }
    }

    /** Replay only explicit refused-admission markers, independent of ownership snapshots. */
    replayFailedAdmissions(retainedIds: ReadonlySet<string>) {
        const tabIdSchema = createTabIdSchema();
        const markedIds = new Set<string>();
        const failedIds = new Set<string>();
        try {
            const markers = Array.from({ length: sessionStorage.length }, (_, index) =>
                sessionStorage.key(index),
            ).filter((key): key is string => key?.startsWith(FAILED_ADMISSION_PREFIX) ?? false);
            const validMarkers: Array<{ key: string; tabId: string }> = [];
            const invalidMarkers: string[] = [];
            const removable = new Set<string>();
            let storageReadError: unknown;
            for (const marker of markers) {
                const tabId = marker.slice(FAILED_ADMISSION_PREFIX.length);
                if (!tabIdSchema.safeParse(tabId).success) {
                    invalidMarkers.push(marker);
                    continue;
                }
                let value: string | null;
                try {
                    value = sessionStorage.getItem(marker);
                } catch (error) {
                    // Keep an unread marker's tree out of the sweep until its intent is known.
                    markedIds.add(tabId);
                    failedIds.add(tabId);
                    storageReadError ??= error;
                    continue;
                }
                if (value !== FAILED_ADMISSION_VALUE) {
                    invalidMarkers.push(marker);
                    continue;
                }
                validMarkers.push({ key: marker, tabId });
                if (!retainedIds.has(tabId)) {
                    markedIds.add(tabId);
                    try {
                        if (this.isStoredTree(tabId)) removable.add(tabId);
                    } catch (error) {
                        failedIds.add(tabId);
                        storageReadError ??= error;
                    }
                }
            }
            if (storageReadError !== undefined)
                reportPersistError(persistStorageWriteError(storageReadError));
            const failed = this.removeKnownTreesSafely(removable);
            for (const id of failed) failedIds.add(id);
            let markerError: unknown;
            let markerRemovalFailed = false;
            const markersToClear = [
                ...invalidMarkers,
                ...validMarkers.filter(({ tabId }) => !failedIds.has(tabId)).map(({ key }) => key),
            ];
            for (const key of markersToClear) {
                try {
                    sessionStorage.removeItem(key);
                } catch (error) {
                    markerRemovalFailed = true;
                    markerError ??= error;
                }
            }
            if (markerRemovalFailed) reportPersistError(persistStorageWriteError(markerError));
        } catch (error) {
            reportPersistError(persistStorageWriteError(error));
        }
        return { markedIds, failedIds };
    }

    /** Remove a known set and report one failure while retaining every refused ID for retry. */
    removeKnownTreesSafely(tabIds: Iterable<string>): Set<string> {
        const failed = new Set<string>();
        let firstError: unknown;
        let hadError = false;
        try {
            for (const tabId of tabIds) {
                try {
                    this.remove(tabId);
                } catch (error) {
                    failed.add(tabId);
                    hadError = true;
                    firstError ??= error;
                }
            }
        } catch (error) {
            hadError = true;
            firstError ??= error;
        }
        if (hadError) reportPersistError(persistStorageWriteError(firstError));
        return failed;
    }

    /** Check whether a session key still contains a decodable tree. */
    isStoredTree(tabId: string) {
        const raw = sessionStorage.getItem(tabId);
        // A null value also decodes to null; this guard keeps it out of the string-only API.
        // Stryker disable next-line ConditionalExpression: both branches return false for null.
        return raw !== null && this.isDecodableTreeValue(raw);
    }

    /**
     * A decodable tree is a target under any id. An absent value ends the intent (d-20261008-09).
     * Present but undecodable bytes are a target only under a UUID id, because only the tree
     * repository writes under a workspace tab id and the id came from crypto.randomUUID().
     * A legacy non-UUID id may name another store's session key.
     */
    hasPendingRemovalTarget(tabId: string): boolean {
        const raw = sessionStorage.getItem(tabId);
        if (raw === null) return false;
        if (this.isDecodableTreeValue(raw)) return true;
        return createTabIdSchema().safeParse(tabId).success;
    }

    private isDecodableTreeValue(raw: string): boolean {
        return decodeLegacyOrCompressed(raw) !== null;
    }

    /** Reclaim durable trees absent from the retained workspace; other session values stay untouched. */
    removeOrphanedTrees(retainedIds: ReadonlySet<string>) {
        this.removeKnownTreesSafely(this.storedTreeKeys(retainedIds));
    }

    /** Snapshot valid stored tree keys through the same bounded validator used by orphan cleanup. */
    snapshotStoredTreeKeys(
        maxTreeKeys: number,
        maxKeyLength: number,
        excludedKeys?: ReadonlySet<string>,
    ): string[] | null {
        const keys: string[] = [];
        try {
            for (const key of this.storedTreeKeys(excludedKeys)) {
                if (key.length > maxKeyLength || keys.length === maxTreeKeys) return null;
                keys.push(key);
            }
        } catch (error) {
            reportPersistError(persistStorageWriteError(error));
            return null;
        }
        return keys;
    }

    private *storedTreeKeys(excludedKeys?: ReadonlySet<string>): Generator<string> {
        const keys = Array.from({ length: sessionStorage.length }, (_, index) =>
            sessionStorage.key(index),
        );
        for (const key of keys) {
            if (
                !key ||
                NON_TREE_SESSION_KEYS.has(key) ||
                key.startsWith(FAILED_ADMISSION_PREFIX) ||
                excludedKeys?.has(key)
            )
                continue;
            if (!this.isStoredTree(key)) continue;
            yield key;
        }
    }

    flush({ notify = false }: { notify?: boolean } = {}): string[] {
        if (this.flushTimeout) {
            clearTimeout(this.flushTimeout);
            this.flushTimeout = null;
        }
        const failedTabIds: string[] = [];
        let notifyError: unknown;
        // Pending entries passed the write blocker before admission and stay authoritative until
        // flushed, so checking the same gate again here cannot add protection.
        for (const [tabId, value] of this.pending) {
            try {
                // The read gate, applied before the write: a tree that would not rehydrate is
                // never stored in place of the last one that does.
                if (!canRehydrate(value.state)) {
                    throw new Error("Could not save this game: it no longer fits tab storage.");
                }
                sessionStorage.setItem(tabId, serializeStorageValue(value));
                this.pending.delete(tabId);
                this.setReadStatus(tabId, { kind: "available" });
            } catch (error) {
                failedTabIds.push(tabId);
                warnSafely(`Could not persist tree storage ${tabId}: ${String(error)}`);
                if (notifyError === undefined) notifyError = error;
            }
        }
        if (notify && notifyError !== undefined) {
            reportPersistError(persistStorageWriteError(notifyError));
        }
        return failedTabIds;
    }

    pendingCount() {
        return this.pending.size;
    }

    private scheduleFlush() {
        this.bindFlushHandlers();
        if (this.flushTimeout) clearTimeout(this.flushTimeout);
        this.flushTimeout = setTimeout(() => {
            this.flushTimeout = null;
            this.flush({ notify: true });
        }, DEBOUNCE_MS);
        // The shared test fixture owns scheduled writes across module resets. This hook
        // neither imports test/platform modules nor changes production lifecycle handlers.
        if (import.meta.env.MODE === "test") {
            (
                globalThis as typeof globalThis & {
                    __chessfableTrackTabStorage?: (repository: TabStorageRepository) => void;
                }
            ).__chessfableTrackTabStorage?.(this);
        }
    }

    private writeBlocker(
        tabId: string,
        requireExisting = false,
    ): Extract<TabTreeStorageStatus, { kind: "unreadable" | "unavailable" }> | null {
        if (NON_TREE_SESSION_KEYS.has(tabId)) {
            return {
                kind: "unavailable",
                error: new Error("The key belongs to another session store."),
            };
        }
        let status = this.getStatus(tabId);
        if (status.kind === "not-read") {
            this.readTree(tabId, requireExisting);
            status = this.getStatus(tabId);
        }
        return status.kind === "unreadable" || status.kind === "unavailable" ? status : null;
    }

    private setReadStatus(tabId: string, next: TabTreeStorageStatus) {
        const current = this.getStatus(tabId);
        const currentDetail =
            current.kind === "unreadable"
                ? current.rawValue
                : (current as { error?: unknown }).error;
        const nextDetail =
            next.kind === "unreadable" ? next.rawValue : (next as { error?: unknown }).error;
        const unchanged = current.kind === next.kind && currentDetail === nextDetail;
        if (unchanged) return;
        if (next.kind === "not-read") this.readStatuses.delete(tabId);
        else this.readStatuses.set(tabId, next);
        for (const listener of this.statusListeners.get(tabId) ?? []) listener();
    }

    private validatedClone(source: StorageValue<unknown>): ValidatedStoredTree | null {
        // Round-trip through serialize/parse so a pending partialized store
        // (which still carries action functions) cannot reach structuredClone.
        const copy = decodeLegacyOrCompressed(serializeStorageValue(source));
        if (!copy) return null;
        // A duplicate tab must not share a live analysis lease.
        copy.state.report = { ...copy.state.report, inProgress: false, operationId: null };
        return copy;
    }

    private bindFlushHandlers() {
        const addEventListener = globalThis.addEventListener;
        if (this.handlersBound || !addEventListener) return;
        const flush = () => this.flush();
        addEventListener.call(globalThis, "beforeunload", flush);
        addEventListener.call(globalThis, "pagehide", flush);
        this.handlersBound = true;
    }
}

export const tabStorage = new TabStorageRepository();
