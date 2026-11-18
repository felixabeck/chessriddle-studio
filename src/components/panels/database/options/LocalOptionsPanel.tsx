import { Stack } from "@mantine/core";
import type { DatabaseHandle } from "@/bindings";
import { useExplorerFilters } from "../useExplorerFilters";
import LocalFiltersForm from "./LocalFiltersForm";
import PositionSearchEditor from "./PositionSearchEditor";

function LocalOptionsPanel({
  boardFen,
  database,
}: {
  boardFen: string;
  database: DatabaseHandle | null;
}) {
  const { filters, setFilters } = useExplorerFilters(database);
  return (
    <Stack>
      <LocalFiltersForm database={database} filters={filters} setFilters={setFilters} />
      <PositionSearchEditor boardFen={boardFen} />
    </Stack>
  );
}

export default LocalOptionsPanel;
