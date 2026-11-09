import { Box, Group, Stack } from "@mantine/core";
import { useAtomValue } from "jotai";
import { sessionsAtom } from "@/state/atoms";
import Accounts from "./Accounts";
import Databases from "./Databases";

// Each column wraps from this basis: side by side while two fit, stacked once they do not (the rem
// basis scales with the app font, so a large font scale stacks them sooner).
const column = { flex: "1 1 15rem", minWidth: 0 } as const;

function AccountsPage() {
  const sessions = useAtomValue(sessionsAtom);

  return (
    <Group wrap="wrap" px={{ base: "xs", xs: "md" }} py="md" h="100%" style={{ overflowY: "auto" }}>
      <Stack h="100%" style={column}>
        <Accounts />
      </Stack>

      {sessions.length > 0 && (
        <Box h="100%" style={{ ...column, overflow: "hidden" }}>
          <Databases />
        </Box>
      )}
    </Group>
  );
}

export default AccountsPage;
