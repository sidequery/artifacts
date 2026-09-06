import { H1, Stack, Stat, Table, Text } from "herdr/canvas";

export default function Overview() {
  return (
    <Stack gap={16}>
      <H1>herdr-canvas</H1>
      <Text>
        A live React canvas compiled by Bun and opened in a Herdr Browser pane.
      </Text>
      <Stat value="1" label="Sample canvases" />
      <Table
        headers={["Layer", "Job"]}
        rows={[
          ["herdr-canvas", "Compile, serve, typecheck, MCP/CLI"],
          ["herdr-browser", "Chromium pane + CDP"],
        ]}
      />
    </Stack>
  );
}
