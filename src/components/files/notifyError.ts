import { notifications } from "@mantine/notifications";
import i18n from "@/i18n";
import { errorUnlessCancelled, isErrorReported } from "@/platform/errors";
import { rootFailureMessage, type RootFailureDomain } from "./listingFailure";
import { workspaceErrorMessage } from "./workspaceError";
import { remoteHttpGuidance } from "./remoteHttpGuidance";

export function notifyUnlessCancelled(
    title: string,
    error: unknown,
    domain?: RootFailureDomain,
): void {
    if (isErrorReported(error)) return;
    const visible = errorUnlessCancelled(error);
    if (visible) {
        const fallback =
            (domain ? rootFailureMessage(domain, visible) : undefined) ?? visible.message;
        let message =
            domain === "files"
                ? workspaceErrorMessage(visible, fallback)
                : visible.nameTaken === true
                  ? i18n.t("Common.NameAlreadyUsed")
                  : fallback;
        const remoteRejection =
            visible.rootFailure == null && visible.backendCategory !== "operation-and-cleanup"
                ? visible.remoteHttpRejection
                : undefined;
        if (remoteRejection) {
            message = remoteHttpGuidance(remoteRejection);
        }
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
