import { useState } from "sidequery/artifacts";

export const demoView: string = "Launch checklist";

const tasks = [
  { name: "Review the onboarding flow", owner: "Alex", area: "Product", done: true },
  { name: "Publish the getting started guide", owner: "Sam", area: "Docs", done: true },
  { name: "Check the mobile experience", owner: "Jordan", area: "Design", done: false },
  { name: "Share the preview with the team", owner: "Alex", area: "Product", done: false },
];

export default function LibraryDemo() {
  const [items, setItems] = useState(tasks);
  const complete = items.filter(item => item.done).length;
  return <main style={{ fontFamily: "system-ui, sans-serif", color: "#1b1917", background: "#fff", minHeight: "100vh", padding: "clamp(20px, 5vw, 56px)", boxSizing: "border-box" }}>
    <style>{`html, body { background: #fff; color-scheme: light; } #root { padding: 0; }`}</style>
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      <p style={{ fontSize: 11, letterSpacing: ".1em", color: "#8b8378", textTransform: "uppercase", margin: "0 0 24px" }}>Sidequery · Demo workspace</p>
      <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-1px", margin: "0 0 10px" }}>{demoView}</h1>
      <p style={{ color: "#6d665d", fontSize: 14, lineHeight: 1.6, margin: "0 0 32px" }}>
        {demoView === "Team directory" ? "The people bringing the next release together." : demoView === "Release notes" ? "A shared home for what shipped and what comes next." : "A little structure for the next big thing. Keep track of the details, together."}
      </p>
      {demoView === "Team directory" ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        {[["Alex", "Product"], ["Sam", "Engineering & docs"], ["Jordan", "Design"]].map(([name, role]) => <article key={name} style={{ border: "1px solid #e7e4dd", borderRadius: 12, padding: 24 }}>
          <div style={{ background: "#f4e8d0", borderRadius: "50%", width: 40, height: 40, display: "grid", placeItems: "center", marginBottom: 24 }}>{name!.slice(0, 1)}</div>
          <strong>{name}</strong><p style={{ color: "#6d665d", fontSize: 13 }}>{role}</p>
        </article>)}
      </div> : demoView === "Release notes" ? <div style={{ borderTop: "1px solid #e7e4dd" }}>
        {[["A familiar workspace", "Warm surfaces, quiet controls, and more room for your work."], ["Everything in one place", "Browse artifacts, inspect source, and revisit previous revisions."], ["Made for sharing", "Export a project or remix it into something new."]].map(([title, text], index) => <article key={title} style={{ padding: "24px 0", borderBottom: "1px solid #e7e4dd", display: "flex", gap: 24 }}>
          <span style={{ color: "#8b8378", fontSize: 12 }}>0{index + 1}</span><div><strong style={{ fontSize: 15 }}>{title}</strong><p style={{ color: "#6d665d", fontSize: 14, marginBottom: 0 }}>{text}</p></div>
        </article>)}
      </div> : <>
        <div style={{ background: "#f6f5f1", border: "1px solid #e7e4dd", borderRadius: 12, padding: 24, marginBottom: 32 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}><span style={{ fontSize: 13, color: "#6d665d" }}>Release readiness</span><span style={{ fontSize: 13 }}>{complete} of {items.length} complete</span></div>
          <progress aria-label="Release readiness" value={complete} max={items.length} style={{ width: "100%", height: 6, accentColor: "#b78a37" }} />
        </div>
        <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>Before we ship</h2>
        {items.map((item, index) => <label key={item.name} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 60, borderBottom: "1px solid #e7e4dd", cursor: "pointer" }}>
          <input type="checkbox" checked={item.done} onChange={() => setItems(current => current.map((value, position) => position === index ? { ...value, done: !value.done } : value))} style={{ width: 16, height: 16, accentColor: "#1b1917", flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 14, color: item.done ? "#8b8378" : "#1b1917", textDecoration: item.done ? "line-through" : "none" }}>{item.name}</span>
          <span style={{ fontSize: 12, color: "#6d665d" }}>{item.owner}</span>
        </label>)}
      </>}
      <p style={{ color: "#8b8378", fontSize: 12, marginTop: 32 }}>Sample content · Explore the library, view source, or try a different revision.</p>
    </div>
  </main>;
}
