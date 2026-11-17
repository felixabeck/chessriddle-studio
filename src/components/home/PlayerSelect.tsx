import { Group, Select, Text, type MantineSpacing } from "@mantine/core";
import { useAtomValue } from "jotai";
import { sessionsAtom } from "@/state/atoms";
import { playerSites, sessionPlayerName } from "@/utils/session";
import { SiteLogos, siteLogosWidth } from "./SiteLogo";

/** The player dropdown of the statistics card; every player shows the sites its accounts live on. */
export function PlayerSelect({
  label,
  value,
  onChange,
  mt,
}: {
  label: string;
  value: string;
  onChange: (name: string) => void;
  mt?: MantineSpacing;
}) {
  const sessions = useAtomValue(sessionsAtom);
  const players = Array.from(new Set(sessions.map(sessionPlayerName)));
  const selectedSites = playerSites(sessions, value);
  const sectionWidth = siteLogosWidth(selectedSites.length);

  return (
    <Select
      aria-label={label}
      value={value}
      data={players}
      onChange={(name) => onChange(name || "")}
      clearable={false}
      allowDeselect={false}
      fw="bold"
      mt={mt}
      leftSection={<SiteLogos sites={selectedSites} />}
      leftSectionWidth={sectionWidth || undefined}
      // Pad the right as far as the logos pad the left, so the centred name stays centred.
      rightSectionWidth={Math.max(sectionWidth, 36)}
      renderOption={({ option }) => (
        <Group gap="xs" wrap="nowrap">
          <SiteLogos sites={playerSites(sessions, option.value)} />
          <Text fw="bold" inherit>
            {option.label}
          </Text>
        </Group>
      )}
      styles={{
        input: {
          textAlign: "center",
          fontSize: "1.25rem",
        },
      }}
    />
  );
}
