import { notifications } from "@mantine/notifications";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import i18n from "@/i18n";
import { catalogueI18n } from "@/tests/catalogues";
import { markErrorReported } from "@/platform/errors";
import { notifyListenerError, notifyUnlessCancelled, runUnlessCancelled } from "./notifyError";

const fallbackTranslation = vi.mocked(i18n.t).getMockImplementation()!;

for (const locale of ["en-US", "de-DE"] as const) {
    describe(`download failure notifications in ${locale}`, () => {
        let catalogue: Awaited<ReturnType<typeof catalogueI18n>>;
        beforeEach(async () => {
            catalogue = await catalogueI18n(locale);
            vi.mocked(i18n.t).mockImplementation(catalogue.t);
        });
        afterEach(() => {
            vi.mocked(i18n.t).mockImplementation(fallbackTranslation);
        });

        test.each(["database", "puzzle", "engine", "files", undefined] as const)(
            "shows translated name-taken guidance in %s",
            (domain) => {
                notifyUnlessCancelled(
                    "Error",
                    {
                        tag: "backend-error",
                        category: "conflict",
                        message: "Conflict: workspace file already exists",
                        nameTaken: true,
                    },
                    domain,
                );
                expect(notifications.show).toHaveBeenCalledExactlyOnceWith({
                    color: "danger",
                    title: "Error",
                    message: catalogue.t("Common.NameAlreadyUsed"),
                });
                expect(catalogue.t("Common.NameAlreadyUsed")).not.toBe("Common.NameAlreadyUsed");
            },
        );

        test.each([
            {
                status: 401,
                authorizationSent: true,
                key: "Common.RemoteRequest.AuthorizationRejected",
            },
            { status: 401, authorizationSent: false, key: "Common.RemoteRequest.Unauthorized" },
            { status: 403, authorizationSent: true, key: "Common.RemoteRequest.AccessDenied" },
            { status: 404, authorizationSent: false, key: "Common.RemoteRequest.NotFound" },
            { status: 429, authorizationSent: false, key: "Common.RemoteRequest.RateLimited" },
            { status: 500, authorizationSent: false, key: "Common.RemoteRequest.ServerFailed" },
            { status: 599, authorizationSent: true, key: "Common.RemoteRequest.ServerFailed" },
            { status: 400, authorizationSent: false, key: "Common.RemoteRequest.Rejected" },
            { status: 499, authorizationSent: true, key: "Common.RemoteRequest.Rejected" },
            { status: 600, authorizationSent: true, key: "Common.RemoteRequest.Rejected" },
        ])(
            "shows shared guidance for $status with authorizationSent=$authorizationSent",
            ({ status, authorizationSent, key }) => {
                for (const domain of [
                    undefined,
                    "database",
                    "puzzle",
                    "engine",
                    "files",
                ] as const) {
                    vi.mocked(notifications.show).mockClear();
                    notifyUnlessCancelled(
                        "Error",
                        {
                            tag: "backend-error",
                            category: status === 401 ? "authentication" : "network",
                            message: `Remote HTTP request rejected: status ${status}`,
                            remoteHttpRejection: { status, authorizationSent },
                        },
                        domain,
                    );
                    expect(notifications.show).toHaveBeenCalledExactlyOnceWith(
                        expect.objectContaining({
                            color: "danger",
                            title: "Error",
                            message: catalogue.t(key),
                        }),
                    );
                    expect(catalogue.t(key)).not.toBe(key);
                }
            },
        );

        test.each(["files", "database", "puzzle", "engine", undefined] as const)(
            "preserves cleanup guidance in %s",
            (domain) => {
                notifyUnlessCancelled(
                    "Error",
                    {
                        tag: "backend-error",
                        category: "operation-and-cleanup",
                        message: "Combined operation failure",
                        remoteHttpRejection: { status: 404, authorizationSent: false },
                    },
                    domain,
                );
                expect(notifications.show).toHaveBeenCalledExactlyOnceWith({
                    color: "danger",
                    title: "Error",
                    message:
                        domain === "files"
                            ? catalogue.t("Files.OperationAndCleanupFailed")
                            : "Combined operation failure",
                });
            },
        );

        test.each([
            ["database", "Databases.LoadError.RootMissing"],
            ["puzzle", "Puzzle.LoadError.RootMissing"],
            ["engine", "Engines.LoadError.RootMissing"],
            ["files", "Files.LoadFailed.Missing"],
        ] as const)("preserves the %s root label", (domain, key) => {
            notifyUnlessCancelled(
                "Error",
                {
                    tag: "backend-error",
                    category: "io",
                    message: "Root unavailable",
                    rootFailure: "missing",
                    remoteHttpRejection: { status: 404, authorizationSent: false },
                },
                domain,
            );
            expect(notifications.show).toHaveBeenCalledExactlyOnceWith({
                color: "danger",
                title: "Error",
                message: catalogue.t(key),
            });
        });

        test("keeps cancellation silent with remote detail", () => {
            notifyUnlessCancelled(
                "Error",
                {
                    tag: "backend-error",
                    category: "cancellation",
                    message: "Cancellation",
                    remoteHttpRejection: { status: 401, authorizationSent: true },
                },
                "database",
            );
            expect(notifications.show).not.toHaveBeenCalled();
        });
    });
}

vi.mock("@mantine/notifications", () => ({
    notifications: { show: vi.fn() },
}));
vi.mock("@/i18n", async (original) => ({
    ...(await original<typeof import("@/i18n")>()),
    default: {
        t: vi.fn(
            (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
        ),
    },
}));

afterEach(() => {
    vi.mocked(notifications.show).mockClear();
});

test("keeps the pinned Cancellation display silent", () => {
    notifyUnlessCancelled("Common.Error", new Error("Cancellation"));
    expect(notifications.show).not.toHaveBeenCalled();
});

test("notifies a real failure", () => {
    notifyUnlessCancelled("Common.Error", new Error("permission denied"));
    expect(notifications.show).toHaveBeenCalledWith({
        color: "danger",
        title: "Common.Error",
        message: "permission denied",
    });
});

test("only explicitly marked errors skip notification, without changing equivalent ordinary errors", () => {
    const failure = {
        tag: "backend-error",
        category: "network",
        message: "Network request failed",
    };
    const otherFailure = { ...failure };
    markErrorReported(failure);
    notifyUnlessCancelled("Common.Error", failure, "engine");
    expect(notifications.show).not.toHaveBeenCalled();
    notifyUnlessCancelled("Common.Error", otherFailure, "engine");
    expect(notifications.show).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message: otherFailure.message,
    });
    notifyUnlessCancelled("Common.Error", otherFailure, "engine");
    expect(notifications.show).toHaveBeenCalledTimes(2);
});

test("listener and async notification catches respect explicit reporting ownership", async () => {
    const failure = new Error("Network request failed");
    markErrorReported(failure);
    notifyListenerError(failure);
    await expect(
        runUnlessCancelled("Common.Error", async () => {
            throw failure;
        }),
    ).resolves.toBeUndefined();
    expect(notifications.show).not.toHaveBeenCalled();
});

test("files cleanup notifications select localized copy without changing other domains", () => {
    const cause = {
        tag: "backend-error",
        category: "operation-and-cleanup",
        message: "private diagnostic",
    };
    notifyUnlessCancelled("Error", cause, "files");
    expect(notifications.show).toHaveBeenLastCalledWith(
        expect.objectContaining({
            message:
                "The file operation failed, and cleanup also failed. Files or folders may remain. Check the collection before trying again.",
        }),
    );
    notifyUnlessCancelled("Error", cause, "engine");
    expect(notifications.show).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "private diagnostic" }),
    );
});

test("does not treat abort-like diagnostics as picker cancellation", () => {
    notifyUnlessCancelled("Common.Error", new Error("connection aborted"));
    expect(notifications.show).toHaveBeenCalledWith({
        color: "danger",
        title: "Common.Error",
        message: "connection aborted",
    });
});

test("notifies a real listener failure with the common error title", () => {
    notifyListenerError(new Error("listener unavailable"));
    expect(notifications.show).toHaveBeenCalledWith({
        color: "danger",
        title: "Common.Error",
        message: "listener unavailable",
    });
});

test("keeps a pinned listener Cancellation silent", () => {
    notifyListenerError(new Error("Cancellation"));
    expect(notifications.show).not.toHaveBeenCalled();
});

test("runUnlessCancelled returns the adopted value and stays silent on Cancellation", async () => {
    await expect(runUnlessCancelled("Common.Error", async () => "handle")).resolves.toBe("handle");
    await expect(
        runUnlessCancelled("Common.Error", async () => {
            throw new Error("Cancellation");
        }),
    ).resolves.toBeUndefined();
    expect(notifications.show).not.toHaveBeenCalled();
});

test("runUnlessCancelled notifies a real failure and does not return a value", async () => {
    await expect(
        runUnlessCancelled("Common.Error", async () => {
            throw new Error("permission denied");
        }),
    ).resolves.toBeUndefined();
    expect(notifications.show).toHaveBeenCalledWith({
        color: "danger",
        title: "Common.Error",
        message: "permission denied",
    });
});

test.each([
    ["database", "This database folder is no longer available. Choose another."],
    ["puzzle", "This puzzle folder is no longer available. Choose another in Settings."],
    ["engine", "This engine folder is no longer available. Choose another in Settings."],
    ["files", "This collection is no longer available. Choose another."],
] as const)("%s notifies its root sentence through both entry points", async (domain, message) => {
    const error = {
        tag: "backend-error",
        category: "io",
        message: "native failure",
        rootFailure: "missing",
    };
    notifyUnlessCancelled("Common.Error", error, domain);
    await runUnlessCancelled(
        "Common.Error",
        async () => {
            throw error;
        },
        domain,
    );
    expect(notifications.show).toHaveBeenCalledTimes(2);
    expect(notifications.show).toHaveBeenNthCalledWith(1, {
        color: "danger",
        title: "Common.Error",
        message,
    });
    expect(notifications.show).toHaveBeenNthCalledWith(2, {
        color: "danger",
        title: "Common.Error",
        message,
    });
});

test.each(["database", "puzzle", "engine", "files"] as const)(
    "%s preserves unlabelled errors and cancellation",
    (domain) => {
        notifyUnlessCancelled(
            "Common.Error",
            { tag: "backend-error", category: "conflict", message: "workspace root changed" },
            domain,
        );
        expect(notifications.show).toHaveBeenCalledWith({
            color: "danger",
            title: "Common.Error",
            message: "workspace root changed",
        });
        vi.mocked(notifications.show).mockClear();
        notifyUnlessCancelled(
            "Common.Error",
            {
                tag: "backend-error",
                category: "cancellation",
                message: "Cancellation",
                rootFailure: "changed",
            },
            domain,
        );
        expect(notifications.show).not.toHaveBeenCalled();
    },
);

test.each(["puzzle", "engine"] as const)(
    "%s retains the backend message for too-large",
    (domain) => {
        notifyUnlessCancelled(
            "Common.Error",
            {
                tag: "backend-error",
                category: "resource-limit",
                message: "listing bound reached",
                rootFailure: "too-large",
            },
            domain,
        );
        expect(notifications.show).toHaveBeenCalledWith({
            color: "danger",
            title: "Common.Error",
            message: "listing bound reached",
        });
    },
);
