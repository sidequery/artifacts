import { expect } from "bun:test";
import type { FrameLocator, Page } from "playwright";

export const VIEWPORT_ARTIFACT = `import { useState } from "sidequery/artifacts";
export default function Presentation() {
  const [expanded, setExpanded] = useState(false);
  return <main style={{ minHeight: expanded ? "150vh" : "100vh", boxSizing: "border-box", padding: 32, background: "white", color: "black", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
    <header>Presentation</header>
    <footer><button onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more"}</button></footer>
  </main>;
}`;

export async function checkArtifactLayout(view: Page | FrameLocator) {
  const presentation = view.getByRole("main");
  await presentation.waitFor();
  const layout = await presentation.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const header = element.querySelector("header")!.getBoundingClientRect();
    const footer = element.querySelector("footer")!.getBoundingClientRect();
    return {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      headerX: header.x, headerY: header.y, footerBottom: footer.bottom,
    };
  });
  expect(layout.x).toBe(0);
  expect(layout.y).toBe(0);
  expect(layout.width).toBe(layout.viewportWidth);
  expect(layout.height).toBe(layout.viewportHeight);
  expect(layout.scrollWidth).toBe(layout.viewportWidth);
  expect(layout.scrollHeight).toBe(layout.viewportHeight);
  expect(layout.headerX).toBe(32);
  expect(layout.headerY).toBe(32);
  expect(layout.footerBottom).toBe(layout.viewportHeight - 32);

  await view.getByRole("button", { name: "Show more", exact: true }).click();
  await view.getByRole("button", { name: "Show less", exact: true }).waitFor();
  expect(await presentation.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  // The footer remains reachable when the artifact intentionally exceeds the viewport.
  await view.getByRole("button", { name: "Show less", exact: true }).click();
  await view.getByRole("button", { name: "Show more", exact: true }).waitFor();
}
