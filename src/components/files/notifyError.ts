import { notifications } from "@mantine/notifications";
import i18n from "@/i18n";
import type { RemoteHttpRejection } from "@/bindings";
import { type AppError, errorUnlessCancelled, isErrorReported } from "@/platform/errors";
import { rootFailureMessage, type RootFailureDomain } from "./listingFailure";
import { workspaceErrorMessage } from "./workspaceError";
import { remoteHttpGuidance } from "./remoteHttpGuidance";

export function failureMessage(
    visible: AppError,
    domain: RootFailureDomain | undefined,
    fallback: string,
): { message: string; remoteRejection: RemoteHttpRejection | undefined } {
    const rootMessage = (domain ? rootFailureMessage(domain, visible) : undefined) ?? fallback;
    let message =
        domain === "files"
            ? workspaceErrorMessage(visible, rootMessage)
            : visible.nameTaken === true
              ? i18n.t("Common.NameAlreadyUsed")
              : rootMessage;
    const remoteRejection =
        visible.rootFailure == null && visible.backendCategory !== "operation-and-cleanup"
            ? visible.remoteHttpRejection
            : undefined;
    if (remoteRejection) message = remoteHttpGuidance(remoteRejection);
    return { message, remoteRejection };
}

/** Inline failures use translated fallback copy and never notify. */
export function inlineFailureMessage(
    error: unknown,
    domain: RootFailureDomain | undefined,
    fallback: string,
): string | undefined {
    if (error == null) return undefined;
    const visible = errorUnlessCancelled(error);
    return visible ? failureMessage(visible, domain, fallback).message : undefined;
}

export function notifyUnlessCancelled(
    title: string,
    error: unknown,
    domain?: RootFailureDomain,
): void {
    if (isErrorReported(error)) return;
    const visible = errorUnlessCancelled(error);
    if (visible) {
        const { message, remoteRejection } = failureMessage(visible, domain, visible.message);
        notifications.show({
            color: "danger",
            title,
            message,
            ...(remoteRejection
                ? {
                      // The default 200px cap clips guidance at the supported 200% font scale.
                      style: {
                          maxHeight: "calc(100dvh - 2 * var(--mantine-spacing-md))",
                          alignItems: "flex-start",
                          overflowY: "auto",
                      } as const,
                      styles: {
                          body: { minWidth: 0, overflow: "visible" },
                          title: {
                              overflowWrap: "anywhere",
                              overflow: "visible",
                              paddingInlineEnd: "2.5rem",
                          },
                          description: { overflowWrap: "anywhere", overflow: "visible" },
                          closeButton: {
                              position: "absolute",
                              top: "var(--mantine-spacing-xs)",
                              insetInlineEnd: "var(--mantine-spacing-xs)",
                          },
                      } as const,
                  }
                : {}),
        });
    }
}

export async function runUnlessCancelled<T>(
    title: string,
    run: () => Promise<T>,
    domain?: RootFailureDomain,
): Promise<T | undefined> {
    try {
        return await run();
    } catch (error) {
        notifyUnlessCancelled(title, error, domain);
        return undefined;
    }
}

export function notifyListenerError(error: unknown): void {
    notifyUnlessCancelled(i18n.t("Common.Error"), error);
}
