import { useTranslation } from "react-i18next";
import ConfirmModal from "../common/ConfirmModal";
import AddDatabase from "./AddDatabase";
import type { DatabaseLibrary } from "./useDatabaseLibrary";

export function DatabaseLibraryDialogs({ library }: { library: DatabaseLibrary }) {
  const { t } = useTranslation();

  return (
    <>
      <ConfirmModal
        title={t("Databases.Delete.Title")}
        description={t("Databases.Delete.Message")}
        opened={library.deleteModalOpen}
        onClose={library.closeDelete}
        onConfirm={library.confirmDelete}
      />

      <AddDatabase
        workspaceFilenames={library.workspaceFilenames}
        opened={library.addOpen}
        setOpened={library.setAddOpen}
        disableLocalConversion={library.conversionInProgress}
        reloadDatabases={library.reloadDatabases}
      />
    </>
  );
}
