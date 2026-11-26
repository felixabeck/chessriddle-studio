import { tauri } from "@/platform/tauri";
import { listingFailure } from "@/components/files/listingFailure";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useStore } from "jotai";
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import {
    refreshDatabaseList,
    revalidateDatabaseList,
    useDatabaseList,
} from "@/hooks/useDatabaseList";
import type { DatabaseHandle } from "@/bindings";
import { notifyUnlessCancelled, runUnlessCancelled } from "@/components/files/notifyError";
import {
    databaseConversionStateAtom,
    databaseConversionRefreshFailedAtom,
    referenceDbAtom,
    runDatabaseConversion,
} from "@/state/atoms";
import { activeDatabaseViewStore, useActiveDatabaseViewStore } from "@/state/store/database";
import { databaseHandleKey, sameDatabaseHandle, type SuccessDatabaseInfo } from "@/utils/db";
import { pickPgnFile } from "@/utils/files";
import {
    deleteDatabaseAndInvalidate,
    invalidateDeletedDatabase,
    runAddGamesToDatabase,
    runPgnExport,
    refreshAfterDatabaseConversion,
} from "./databaseMutation";
import { databaseLoadFailureMessage } from "./databaseLoadFailure";
import { forgetDeletedDatabase } from "./forgetDeletedDatabase";
import { capabilityKey } from "@/utils/pathCapabilities";
import { runFolderSwitch } from "@/components/settings/folderSwitch";
import { standaloneDatabases } from "@/components/library/libraryData";
import { openDatabaseTable } from "@/components/library/openDatabaseTable";

export function useDatabaseLibrary(
    selected: string | null,
    setSelected: Dispatch<SetStateAction<string | null>>,
) {
    const { t } = useTranslation();
    const picker = useSingleFlight();

    // Opening the overview ends the active session; mount-only lets double-click and Explore restore the sidebar's database target.
    useEffect(() => {
        if (activeDatabaseViewStore.getState().database) {
            activeDatabaseViewStore.getState().clearDatabase();
        }
    }, []);

    const { data, error, mutate, owner: databaseOwner } = useDatabaseList();
    const databases = data?.databases;
    const unread = (data?.unread ?? []).map((item, index) => ({
        ...item,
        key: `${capabilityKey(data!.root)}:unread:${index}`,
    }));
    const failure = listingFailure(error);
    const loadFailureMessage = databaseLoadFailureMessage(error, t);
    const needsFolder =
        failure !== "silent" && failure !== "retry" && failure !== "interruptedMove";
    function chooseWorkspace() {
        return picker.run(async () => {
            const result = await runUnlessCancelled(
                t("Common.Error"),
                () => runFolderSwitch(() => tauri.issueDatabaseWorkspace()),
                "database",
            );
            if (!result?.switched) return;
            await databaseOwner!.supersede();
            await mutate();
        });
    }
    const { mutate: mutateCache } = useSWRConfig();
    const { run, supersede } = databaseOwner!;
    const revalidateDatabases = useCallback(
        () => revalidateDatabaseList({ run, supersede }, mutateCache),
        [run, supersede, mutateCache],
    );

    const [open, setOpen] = useState(false);
    const [referenceDatabase, setReferenceDatabase] = useAtom(referenceDbAtom);
    const store = useStore();
    const [conversionState, setConversionState] = useAtom(databaseConversionStateAtom);
    const [importRefreshFailed, setImportRefreshFailed] = useAtom(
        databaseConversionRefreshFailedAtom,
    );
    function retryImportRefresh() {
        return runUnlessCancelled(
            t("Common.Error"),
            async () => {
                await refreshDatabaseList(databaseOwner!, mutateCache);
                setImportRefreshFailed(false);
            },
            "database",
        );
    }
    const conversionInProgress = conversionState.length > 0;
    const visibleDatabases = useMemo(() => {
        return standaloneDatabases(databases ?? [], conversionState);
    }, [databases, conversionState]);
    const selectedDatabase = useMemo(
        () => visibleDatabases.find((db) => databaseHandleKey(db.file) === selected) ?? null,
        [visibleDatabases, selected],
    );
    const setActiveDatabase = useActiveDatabaseViewStore((store) => store.setDatabase);

    const isReference = sameDatabaseHandle(referenceDatabase, selectedDatabase?.file);

    const [deleteModal, setDeleteModal] = useState(false);
    const [exportLoading, setExportLoading] = useState(false);
    const selectedIsTransient = selectedDatabase?.type === "error" && !!selectedDatabase.transient;
    useEffect(() => {
        if (selectedIsTransient) setDeleteModal(false);
    }, [selectedIsTransient]);

    function invalidateDeletedDatabaseState(deleted: DatabaseHandle) {
        setSelected(
            (currentSelected) =>
                invalidateDeletedDatabase(deleted, {
                    selected: currentSelected,
                    reference: referenceDatabase,
                    active: activeDatabaseViewStore.getState().database,
                }).selected,
        );
        forgetDeletedDatabase(deleted, store, mutateCache);
        void revalidateDatabases();
    }

    function changeReferenceDatabase(file: DatabaseHandle) {
        void tauri.clearGames();
        if (sameDatabaseHandle(file, referenceDatabase)) {
            setReferenceDatabase(null);
        } else {
            setReferenceDatabase(file);
        }
    }
    const navigate = useNavigate();

    function addGames(database: SuccessDatabaseInfo) {
        const dest = database.file;
        void runAddGamesToDatabase({
            pickPgnFile,
            convertPgn: async (progressId, files, destination, ticket) => {
                await refreshAfterDatabaseConversion(
                    () => tauri.convertPgn(progressId, files, destination, "", null, ticket),
                    async () => {
                        await refreshDatabaseList(databaseOwner!, mutateCache);
                    },
                    setImportRefreshFailed,
                    t("Common.Error"),
                );
            },
            dest,
            notifyTitle: t("Common.Error"),
            runConversion: (sourceFileName, convert) =>
                runDatabaseConversion(
                    setConversionState,
                    {
                        targetDatabase: dest,
                        targetDatabaseTitle: database.title,
                        sourceFileName,
                    },
                    convert,
                    {
                        onCancelError: (cause) =>
                            notifyUnlessCancelled(t("Common.Error"), cause, "database"),
                    },
                ),
        });
    }

    function exportPgn(database: SuccessDatabaseInfo) {
        void runPgnExport({
            issueDestination: () => tauri.issuePgnExportDestination(),
            exportToPgn: (file, handle) => tauri.exportToPgn(file, handle),
            file: database.file,
            notifyTitle: t("Common.Error"),
            setLoading: setExportLoading,
        });
    }

    async function confirmDelete() {
        if (!selectedDatabase || selectedIsTransient) return;
        await deleteDatabaseAndInvalidate(
            selectedDatabase.file,
            tauri.deleteDatabase,
            invalidateDeletedDatabaseState,
        );
    }

    return {
        databases,
        visibleDatabases,
        collections: data?.collections ?? [],
        unread,
        selectedDatabase,
        selectedIsTransient,
        failure,
        loadFailureMessage,
        needsFolder,
        chooseWorkspace,
        pickerPending: picker.pending,
        importRefreshFailed,
        retryImportRefresh,
        retryLoad: () => mutate(),
        conversionState,
        conversionInProgress,
        convertingSelected: conversionState.some(
            (entry) => entry.targetDatabase && databaseHandleKey(entry.targetDatabase) === selected,
        ),
        referenceDatabase,
        changeReferenceDatabase,
        isReference,
        setSelected,
        revalidateDatabases,
        setActiveDatabase,
        openDatabase: (item: NonNullable<typeof databases>[number]) => {
            if (item.type === "success") openDatabaseTable(item, navigate);
        },
        add: () => setOpen(true),
        addGames,
        exportPgn,
        exportLoading,
        requestDelete: () => setDeleteModal(true),
        deleteModalOpen: deleteModal && !selectedIsTransient,
        closeDelete: () => setDeleteModal(false),
        confirmDelete,
        addOpen: open,
        setAddOpen: setOpen,
        workspaceFilenames: data?.workspaceFilenames ?? [],
        reloadDatabases: () => refreshDatabaseList(databaseOwner!, mutateCache),
    };
}

export type DatabaseLibrary = ReturnType<typeof useDatabaseLibrary>;
