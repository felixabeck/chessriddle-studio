import { Center, Checkbox, Group, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { Cloud, Brain } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { memo } from "react";
import { Trans, useTranslation } from "react-i18next";
import EnginePortrait from "@/components/engines/EnginePortrait";
import InstallStockfishButton from "@/components/engines/InstallStockfishButton";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { enginesAtom } from "@/state/atoms";
import { type Engine } from "@/utils/engines";

function EngineBox({ engine, toggleLoaded }: { engine: Engine; toggleLoaded: () => void }) {
  return (
    <Paper withBorder p="sm" w="100%" h="3rem" onClick={toggleLoaded} style={{ cursor: "pointer" }}>
      <Group wrap="nowrap">
        <Checkbox checked={!!engine.loaded} onChange={() => {}} />
        <EnginePortrait
          engine={engine}
          imageProps={{ w: "1.5rem" }}
          fallback={engine.type !== "local" ? <Cloud size="1.5rem" /> : <Brain size="1.5rem" />}
        />
        <Text lineClamp={1} fz="sm">
          {engine.name}
        </Text>
      </Group>
    </Paper>
  );
}

function EngineSelection() {
  const [engines, setEngines] = useAtom(enginesAtom);
  const { t } = useTranslation();

  if (!engines) return null;

  return (
    <>
      {engines.length === 0 && (
        <Center>
          <Stack miw={0} maw="100%">
            <Text>
              <Trans
                i18nKey="Engines.Selection.None"
                components={{
                  addEngineLink: <Link to="/engines" />,
                }}
              />
            </Text>
            <InstallStockfishButton />
          </Stack>
        </Center>
      )}

      <ScrollArea h={250} scrollbars="y">
        <Stack gap="xs" align="center" w="100%">
          {engines.map((engine) => (
            <EngineBox
              key={engine.id}
              engine={engine}
              toggleLoaded={() => {
                void setEngines(async (prev) =>
                  (await prev).map((e) => (e.id === engine.id ? { ...e, loaded: !e.loaded } : e)),
                ).catch((error) => notifyUnlessCancelled(t("Common.Error"), error));
              }}
            />
          ))}
        </Stack>
      </ScrollArea>
    </>
  );
}

export default memo(EngineSelection);
