import { H1, Stack, Stat, Table, Text } from "sidequery/artifacts";

export default function Overview() {
  return (
    <Stack gap={16}>
      <H1>artifacts</H1>
      <Text>
        A live React artifact compiled by Bun and opened in a Herdr Browser pane.
      </Text>
      <Stat value="1" label="Sample artifacts" />
      <Table
        headers={["Layer", "Job"]}
        rows={[
          ["artifacts", "Compile, serve, typecheck, MCP/CLI"],
          ["herdr-browser", "Chromium pane + CDP"],
        ]}
      />
    </Stack>
  );
}
