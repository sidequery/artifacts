import { Button, H1, Row, Stack, Text, canvasFetch, useCanvasState, useEffect } from "herdr/canvas";

export default function Canvas() {
  const [count, setCount] = useCanvasState<number | null>("count", null);
  const [error, setError] = useCanvasState("error", "");
  async function load(method = "GET") {
    try {
      const response = await canvasFetch("/counter", { method });
      if (!response.ok) throw new Error(`Counter request failed (${response.status})`);
      const data = await response.json() as { value: number };
      setCount(data.value);
      setError("");
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  useEffect(() => { void load(); }, []);
  return <Stack>
    <H1>Persistent counter</H1>
    <Text>Count: {count === null ? "loading" : count}</Text>
    <Row><Button onClick={() => { void load("POST"); }}>Increment</Button><Button onClick={() => { void load(); }}>Refresh</Button></Row>
    {error ? <Text>{error}</Text> : null}
  </Stack>;
}
