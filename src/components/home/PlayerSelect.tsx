import { Group, Select, Text, type MantineSpacing } from "@mantine/core";
import { useAtomValue } from "jotai";
import { sessionsAtom } from "@/state/atoms";
import { playerGroups } from "@/utils/session";
import { SiteLogos, siteLogosWidth } from "./SiteLogo";

/** Width of Mantine's chevron section, the right padding when no logos are wider. */
const CHEVRON_SECTION_WIDTH = 36;

/**
 * The player dropdown of the statistics card. Its value is a player key; every player shows the
 * sites its accounts live on, which tells apart players sharing a name.
 */
export function PlayerSelect({
  ariaLabel,
  value,
  onChange,
  mt,
}: {
  ariaLabel: string;
  value: string;
  onChange: (playerKey: string) => void;
  mt?: MantineSpacing;
}) {
  const sessions = useAtomValue(sessionsAtom);
  const players = playerGroups(sessions);
  const sitesOf = (key: string) => players.find((player) => player.key === key)?.sites ?? [];
  const selectedSites = sitesOf(value);
  const sectionWidth = siteLogosWidth(selectedSites.length);

  return (
    <Select
      aria-label={ariaLabel}
      value={value}
      data={players.map(({ key, name }) => ({ value: key, label: name }))}
      onChange={(key) => onChange(key || "")}
      clearable={false}
      allowDeselect={false}
      fw="bold"
      mt={mt}
      leftSection={<SiteLogos sites={selectedSites} />}
      leftSectionWidth={sectionWidth || undefined}
      // Pad the right as far as the logos pad the left, so the centred name stays centred.
      rightSectionWidth={Math.max(sectionWidth, CHEVRON_SECTION_WIDTH)}
      renderOption={({ option }) => (
        <Group gap="xs" wrap="nowrap">
          <SiteLogos sites={sitesOf(option.value)} />
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
