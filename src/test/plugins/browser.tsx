import { useState } from "react";
import { Button } from "@sidequery/canvas";
import { label, type Label } from "./label";
export type { Tone } from "@sidequery/canvas";
export type { Label } from "./label";
export function PluginCounter({ prefix }: Label) {
  const [count, setCount] = useState(0);
  return <Button onClick={() => setCount(count + 1)}>{label({ prefix }, count)}</Button>;
}
