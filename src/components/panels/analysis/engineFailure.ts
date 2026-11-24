import type { EngineLog, EngineTerminalEntry, EngineTerminalSnapshot } from "@/bindings";
import type { TFunction } from "i18next";
import { normalizeError } from "@/platform/errors";

/** The native snapshot is already safe. Render its text without interpreting markup. */
export function engineFailureMessage(
    t: TFunction,
    snapshot?: EngineTerminalSnapshot,
    message = "",
    cleanupFailed = false,
): string {
    if (cleanupFailed)
        return `${engineFailureMessage(t, snapshot, message)} ${t("Board.Analysis.EngineCleanupFailed")}`;
    if (!snapshot) return message.trim() ? message : t("Board.Analysis.EngineDisconnected");
    if (snapshot.reason) return snapshot.reason;
    if (snapshot.exitStatus?.signal != null)
        return t("Board.Analysis.EngineExitSignal", { signal: snapshot.exitStatus.signal });
    if (snapshot.exitStatus?.code != null)
        return t("Board.Analysis.EngineExitCode", { code: snapshot.exitStatus.code });
    if (snapshot.kind === "protocol-failure") return t("Board.Analysis.EngineProtocolFailure");
    if (snapshot.kind === "process-exit") return t("Board.Analysis.EngineExited");
    return t("Board.Analysis.EngineDisconnected");
}

export function engineTerminalLogs(t: TFunction, entries: EngineTerminalEntry[]): EngineLog[] {
    return entries.map((entry) => ({
        type: "engine",
        value: entry.type === "truncated" ? t("Engines.Logs.TerminalTruncated") : entry.value,
    }));
}

export function reportEngineFailure(t: TFunction, cause: unknown): unknown {
    const failure = normalizeError(cause);
    return failure.engineFailure || failure.backendCategory === "engine-failure"
        ? {
              ...failure,
              message: engineFailureMessage(
                  t,
                  failure.engineFailure,
                  failure.message,
                  failure.backendCategory === "operation-and-cleanup",
              ),
          }
        : cause;
}
