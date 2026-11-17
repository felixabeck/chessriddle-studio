import { SimpleGrid } from "@mantine/core";
import { useAtom } from "jotai";
import { masterOptionsAtom } from "@/state/atoms";
import { ExplorerDateRange } from "./filterControls";

const MasterOptionsPanel = () => {
  const [options, setOptions] = useAtom(masterOptionsAtom);
  return (
    <SimpleGrid cols={2}>
      <ExplorerDateRange
        precision="year"
        value={options}
        onChange={(change) => setOptions({ ...options, ...change })}
      />
    </SimpleGrid>
  );
};

export default MasterOptionsPanel;
