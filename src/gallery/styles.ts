import { fontFaces } from "./brand";
import { themeStyles } from "./theme";

export const galleryStyles = `
  ${fontFaces}
  ${themeStyles}
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body, #root { width: 100%; height: 100%; }
  body { margin: 0; background: var(--page); color: var(--text); font: 13px/1.5 "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  button, input, select, textarea, a { font: inherit; color: inherit; touch-action: manipulation; }
  button, select, .download-link { cursor: pointer; }
  button, select, input { height: 32px; min-height: 32px; line-height: 20px; border: 1px solid transparent; border-radius: 8px; background: transparent; padding: 5px 10px; }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  select, input { border-color: var(--line); min-width: 0; }
  input { background: var(--panel); }
  pre, code, kbd, samp { font-family: var(--font-mono); font-size: 12px; }
  button:disabled, select:disabled { opacity: .45; cursor: default; }
  :is(button, input, select, textarea, summary, a):focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  button, a { -webkit-tap-highlight-color: transparent; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--subtle); }
  .status-dot[data-tone="success"] { background: var(--success); }
  .status-dot[data-tone="warning"] { background: var(--warning); }
  .status-dot[data-tone="error"] { background: var(--error); }
  .select-control { position: relative; display: inline-flex; min-width: 0; vertical-align: middle; }
  .select-control select { appearance: none; width: 100%; background: var(--panel); padding-right: 30px; text-overflow: ellipsis; }
  .select-chevron { position: absolute; pointer-events: none; right: 12px; top: 50%; width: 6px; height: 6px; margin-top: -4px; border-right: 1px solid var(--muted); border-bottom: 1px solid var(--muted); transform: rotate(45deg); }
  .select-control:has(select:disabled) .select-chevron { opacity: .45; }
  @supports (appearance: base-select) {
    .select-control select, .select-control select::picker(select) { appearance: base-select; }
    .select-control select::picker-icon { display: none; }
    .select-control select::picker(select) { margin: 4px 0; padding: 4px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); box-shadow: 0 8px 28px #0002; font: 13px/1.5 "Geist Sans", sans-serif; }
    .select-control option { padding: 6px 10px; border-radius: 6px; gap: 8px; min-height: 32px; }
    .select-control option:checked { background: var(--selected); }
    .select-control option:hover, .select-control option:focus { background: var(--raised); outline: none; }
    .select-control option::checkmark { color: var(--muted); }
  }
  input[type=file] { height: auto; min-height: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--muted); }
  input[type=file]::file-selector-button { height: 32px; margin-right: 10px; padding: 5px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); font: inherit; cursor: pointer; }
  .gallery-app { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
  .app-header { display: flex; align-items: center; gap: 16px; min-height: 48px; padding: 8px 16px; flex-shrink: 0; }
  .library-heading { display: flex; align-items: center; justify-content: space-between; width: 224px; flex-shrink: 0; }
  .wordmark { font-size: 14px; font-weight: 600; letter-spacing: -.3px; }
  .create-item { width: 32px; padding: 0; color: var(--muted); font-size: 22px; font-weight: 400; }
  .create-item[data-popup-open] { background: var(--selected); color: var(--text); }
  .theme-toggle { color: var(--muted); white-space: nowrap; }
  .theme-icon { display: block; width: 15px; height: 15px; border-radius: 50%; }
  .theme-icon.moon { box-shadow: inset 5px -3px 0 0 currentColor; transform: rotate(-15deg); }
  .theme-icon.sun { width: 9px; height: 9px; margin: 3px; border: 1px solid currentColor; box-shadow: 0 -7px 0 -3px currentColor, 0 7px 0 -3px currentColor, 7px 0 0 -3px currentColor, -7px 0 0 -3px currentColor, 5px 5px 0 -3px currentColor, -5px -5px 0 -3px currentColor, 5px -5px 0 -3px currentColor, -5px 5px 0 -3px currentColor; }
  .header-context { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .header-context::before { content: "/"; color: var(--subtle); margin-right: 16px; }
  .header-actions { display: flex; gap: 8px; align-items: center; margin-left: auto; }
  .header-actions .select-control { max-width: 180px; }
  .header-actions select { border-color: transparent; background: transparent; }
  .account { display: flex; align-items: center; gap: 8px; margin-left: 8px; }
  .account-name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
  .gallery-layout { display: grid; grid-template-columns: 256px minmax(0, 1fr); flex: 1; min-height: 0; }
  .library-panel { display: flex; flex-direction: column; min-height: 0; background: var(--page); padding: 0 8px 8px; }
  .connection-status { height: 28px; flex-shrink: 0; padding: 6px 12px 0; margin: 0; color: var(--muted); font-size: 11px; white-space: nowrap; }
  .library-search { position: relative; margin: 0 4px 8px; }
  .search-input { width: 100%; padding-right: 32px; background: var(--panel); }
  .search-input::placeholder { color: var(--subtle); }
  .search-input::-webkit-search-cancel-button { display: none; }
  .clear-search { position: absolute; right: 0; top: 0; bottom: 0; width: 32px; padding: 0; color: var(--muted); font-size: 18px; }
  .share-link-row { display: flex; align-items: flex-end; gap: 8px; width: 100%; flex-wrap: wrap; }
  .share-link-row label { flex: 1; min-width: 180px; }
  .share-link-row input { width: 100%; }
  .folder-row { width: 100%; justify-content: flex-start; gap: 10px; color: var(--muted); text-align: left; }
  .folder-row:hover { background: var(--raised); }
  .folder-chevron { width: 6px; height: 6px; margin: 0 5px 0 3px; flex-shrink: 0; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(-45deg); }
  .folder-row[aria-expanded="true"] .folder-chevron { transform: rotate(45deg); }
  .file-icon { position: relative; width: 12px; height: 15px; border: 1px solid var(--subtle); border-radius: 2px; margin: 0 3px; flex-shrink: 0; }
  .file-icon::after { content: ""; position: absolute; left: 2px; right: 2px; top: 5px; height: 1px; background: var(--subtle); box-shadow: 0 3px 0 var(--subtle); }
  .library-filters { display: flex; gap: 2px; padding: 0 4px 10px; }
  .library-filters button { height: 28px; min-height: 28px; padding: 3px 8px; font-size: 12px; color: var(--muted); }
  .library-filters button[aria-pressed="true"] { color: var(--text); background: var(--selected); }
  .artifact-list { overflow: auto; flex: 1; min-height: 0; padding: 0; }
  .artifact-row { display: flex; justify-content: flex-start; align-items: center; gap: 8px; width: 100%; height: auto; min-height: 34px; text-align: left; padding: 7px 10px; border: 0; border-radius: 8px; margin-bottom: 2px; }
  .artifact-row[aria-current="true"] { background: var(--selected); }
  .artifact-row-copy { min-width: 0; flex: 1; }
  .artifact-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .row-meta { display: flex; align-items: center; gap: 6px; flex-shrink: 0; color: var(--subtle); font-size: 11px; }
  .unsaved-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text); flex-shrink: 0; }
  .library-footer { padding: 8px 12px; color: var(--subtle); font-size: 11px; }
  .library-count { padding: 8px 12px; color: var(--subtle); font-size: 11px; }
  .artifact-detail { display: flex; flex-direction: column; min-width: 0; min-height: 0; margin: 0 8px 8px 0; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  /* Tabs fill the bar height so the active underline sits on its bottom border. */
  .detail-header { display: flex; gap: 16px; align-items: stretch; justify-content: space-between; min-height: 44px; padding: 0 8px 0 16px; flex-shrink: 0; flex-wrap: nowrap; border-bottom: 1px solid var(--line); }
  .detail-header > :not(.view-control) { align-self: center; }
  .detail-title { min-width: 0; flex: 1; }
  .detail-title:has(.revision-chip) { display: flex; align-items: center; gap: 8px; }
  .detail-eyebrow { margin: 0 0 2px; color: var(--muted); font-size: 11px; }
  .detail-title h1 { min-width: 0; margin: 0; font-size: 14px; line-height: 1.3; font-weight: 600; letter-spacing: -.3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-title h1:focus { outline: none; }
  .revision-chip { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; height: 22px; padding: 0 8px; border-radius: 999px; background: var(--raised); color: var(--muted); font-size: 12px; white-space: nowrap; }
  .revision-chip:has(button) { padding-right: 2px; }
  .revision-chip button { position: relative; width: 18px; height: 18px; min-height: 18px; padding: 0; border: 0; border-radius: 50%; color: var(--muted); font-size: 14px; line-height: 1; }
  .revision-chip button::after { content: ""; position: absolute; inset: -8px; }
  .detail-actions { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; justify-content: flex-end; flex-shrink: 0; }
  .detail-actions > :is(button, a) { white-space: nowrap; }
  .download-link { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; min-height: 32px; line-height: 20px; padding: 5px 10px; border: 1px solid transparent; border-radius: 8px; text-decoration: none; }
  .detail-actions :is(.share-action, .open-link) { border-color: var(--line); }
  .view-control { display: flex; align-items: stretch; gap: 2px; overflow-x: auto; min-width: 0; margin-bottom: -1px; }
  .view-control button { height: auto; min-height: 40px; padding: 2px 10px 0; color: var(--muted); flex-shrink: 0; border: 0; border-bottom: 2px solid transparent; border-radius: 0; }
  .view-control button[data-active] { color: var(--text); border-bottom-color: var(--text); background: transparent; }
  .detail-actions button[aria-expanded="true"] { background: var(--raised); }
  .back-library { display: none; }
  .detail-notice { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 16px; border-bottom: 1px solid var(--line); color: var(--muted); }
  .detail-disclosure { flex-shrink: 0; max-height: 42vh; overflow: auto; background: var(--panel); border-bottom: 1px solid var(--line); }
  .link-settings, .script-fields { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
  .link-settings { padding: 12px 20px; }
  .link-settings label, .script-fields label { display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; color: var(--muted); font-size: 12px; }
  .link-settings .download-link { border-color: var(--line); }
  .library-move { padding: 12px 20px; }
  .library-move p { margin: 0 0 10px; max-width: 720px; }
  .link-note { flex-basis: 100%; margin: 0; color: var(--muted); font-size: 12px; }
  .link-settings [role="status"] { align-self: center; }
  .link-settings .muted { font-size: 12px; }
  .script-panel { display: flex; flex-direction: column; flex: 1; width: 100%; min-width: 0; min-height: 0; overflow: hidden; }
  .source-form { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
  .source-form > .script-fields { padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .source-actions { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0; }
  .source-actions p { margin: 0; color: var(--muted); }
  .gallery-app button.primary-action { background: var(--primary); color: var(--primary-text); border-color: var(--primary); font-weight: 600; }
  button.primary-action:disabled { opacity: .45; }
  /* Content actions are outlined; header, tab, and menu controls stay quiet. */
  :where(.artifact-stage, .detail-disclosure, .worker-content, .library-empty, .empty-detail, .save-conflict) button:where(:not(.cm-editor button)) { border-color: var(--line); background: var(--panel); }
  .save-feedback { padding: 8px 16px; flex-shrink: 0; max-height: 30vh; overflow: auto; }
  .save-feedback p { margin: 0 0 6px; }
  .save-feedback button { height: auto; border-color: transparent; background: transparent; text-align: left; text-decoration: underline; }
  .save-feedback pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .agent-onboarding { width: 100%; max-width: 560px; flex-shrink: 0; margin: auto; padding: 32px 28px; }
  .agent-onboarding h2 { font-size: 22px; font-weight: 600; line-height: 1.3; letter-spacing: -.6px; margin: 0 0 8px; text-wrap: balance; }
  .agent-onboarding p { margin: 0; color: var(--muted); }
  .onboarding-intro { max-width: 380px; margin-bottom: 20px !important; }
  .agent-onboarding > .primary-action { min-height: 36px; }
  .agent-connection { border-top: 1px solid var(--line); padding-top: 24px; margin-top: 28px; }
  .agent-connection h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
  .agent-connection > p { font-size: 12px; }
  .agent-onboarding label { display: block; margin: 18px 0 6px; color: var(--muted); font-size: 12px; }
  .onboarding-url-row { display: flex; align-items: center; gap: 8px; }
  .onboarding-url-row input { flex: 1; min-width: 0; height: 36px; font: 12px/1.5 var(--font-mono); text-overflow: ellipsis; }
  .agent-onboarding textarea { display: block; width: 100%; height: 120px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--page); line-height: 1.6; resize: none; }
  .agent-connection button { flex-shrink: 0; border-color: var(--line); background: var(--panel); min-height: 36px; }
  .onboarding-copy-row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  .onboarding-feedback { height: 36px; overflow: auto; display: flex; align-items: center; color: var(--muted); font-size: 12px; }
  .live-data-note { padding: 8px 16px; margin: 0; border-bottom: 1px solid var(--line); color: var(--muted); }
  .artifact-execution fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  .project-import { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 20px 20px 28px; }
  .project-import > :not(details) { max-width: 640px; }
  .project-import p { margin: 0 0 12px; color: var(--muted); line-height: 1.6; }
  .project-import label { display: flex; flex-direction: column; align-items: stretch; gap: 6px; max-width: 420px; margin-top: 16px; color: var(--muted); font-size: 12px; }
  .project-import label input:not([type=file]) { width: 100%; color: var(--text); font-size: 13px; }
  .project-import .import-summary { margin: 12px 0 0; color: var(--text); }
  .project-import .error-message { margin-top: 12px; color: var(--error); }
  .import-actions { display: flex; align-items: center; gap: 8px; margin-top: 20px; }
  .project-import pre { max-height: 160px; overflow: auto; white-space: pre-wrap; }
  .source-actions .source-readonly { margin-right: auto; }
  .save-conflict { flex-shrink: 0; padding: 8px 16px; max-height: 35vh; overflow: auto; }
  .save-conflict button { margin-right: 8px; }
  .script-panel label { color: var(--muted); font-size: 12px; }
  .script-panel :is(input, select) { color: var(--text); }
  .project-editor { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
  .project-file-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .project-file-bar button { background: transparent; border-color: transparent; font: 12px/20px var(--font-mono); }
  .project-file-bar button[aria-pressed="true"] { background: var(--raised); }
  .source-code-editor { display: flex; flex-direction: column; flex: 1; min-height: 180px; min-width: 0; }
  .source-code-surface { flex: 1; min-height: 0; min-width: 0; }
  .source-code-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 16px; border-top: 1px solid var(--line); color: var(--subtle); font-size: 11px; flex-shrink: 0; }
  .source-code-status button { border-color: transparent; background: transparent; color: var(--muted); }
  .project-file-management, .project-dependencies { flex-shrink: 0; border-top: 1px solid var(--line); padding: 0 16px; max-height: 35vh; overflow: auto; }
  .project-file-management > div { padding-bottom: 10px; }
  .project-file-management details { margin: 0; }
  .project-file-management p { margin: 6px 0; }
  .script-panel textarea, .artifact-execution textarea { display: block; width: 100%; min-height: 80px; margin: 6px 0 12px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font: 12px/1.6 var(--font-mono); resize: vertical; }
  summary { display: flex; align-items: center; gap: 8px; list-style: none; cursor: pointer; min-height: 32px; padding-block: 5px; color: var(--text); }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: ""; width: 5px; height: 5px; margin: 0 3px 0 2px; flex-shrink: 0; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(-45deg); }
  details[open] > summary::before { transform: rotate(45deg); }
  .script-panel pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .script-activity, .artifact-execution { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px; }
  .script-activity p { color: var(--muted); }
  .script-activity label { display: block; }
  .script-activity .script-fields label { display: flex; }
  .script-activity label:has(> textarea) { margin-top: 12px; }
  .script-activity details + details { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 8px; }
  .artifact-execution label { display: inline-flex; flex-direction: column; gap: 4px; margin: 8px 12px 8px 0; }
  .artifact-execution label:has(textarea) { display: flex; margin-right: 0; }
  .artifact-execution table { border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 12px; width: 100%; }
  .artifact-execution :is(td, th) { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  .artifact-execution tbody tr:last-child td { border-bottom: 0; }
  .artifact-execution p { color: var(--muted); }
  .script-activity, .artifact-execution { font-size: 12px; line-height: 1.6; }
  .script-activity :is(h2, h3), .artifact-execution :is(h2, h3) { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
  .script-activity :is(button, input, select), .artifact-execution :is(button, input, select) { min-height: 36px; }
  .script-activity > form, .schedule-form form { max-width: 680px; }
  .schedule-summary { padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .schedule-summary h2, .run-history h2 { margin: 0 0 8px; font-size: 15px; }
  .schedule-summary .schedule-state { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 13px; font-weight: 600; }
  .button-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .schedule-form { max-width: 680px; padding: 12px 0; }
  .schedule-form > summary { font-weight: 600; padding-bottom: 12px; }
  .run-history { padding: 20px 0; margin-top: 24px; overflow-x: auto; border-top: 1px solid var(--line); }
  .run-table { width: 100%; overflow: auto; margin-top: 16px; border: 1px solid var(--line); border-radius: 8px; }
  .run-table table { min-width: 640px; }
  .run-table th { color: var(--muted); font-weight: 500; background: var(--page); }
  .run-status { display: inline-flex; align-items: center; gap: 6px; }
  .artifact-execution .run-note { margin: 10px 0 0; color: var(--subtle); font-size: 11px; }
  .muted { color: var(--muted); }
  .artifact-stage { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .source-stage { display: flex; flex: 1; min-width: 0; min-height: 0; }
  .preview-stage { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; background: var(--panel); }
  .preview-frame { display: block; width: 100%; height: 100%; border: 0; background: var(--panel); }
  .preview-loading { position: absolute; inset: 0; display: grid; place-items: center; background: var(--page); color: var(--muted); pointer-events: none; }
  .state-message { margin: 0; padding: 12px; color: var(--muted); }
  .library-empty { padding: 20px 12px; }
  .library-empty p { margin: 0 0 8px; color: var(--muted); }
  .empty-detail { margin: auto; max-width: 400px; padding: 24px; text-align: center; }
  .empty-detail h2 { margin: 0 0 8px; font-size: 18px; font-weight: 500; }
  .empty-detail p { margin: 0; color: var(--muted); }
  .error-message { color: var(--error); }
  .source-form > .error-message, .script-panel > .error-message { margin: 0; padding: 8px 16px; flex-shrink: 0; }
  .refresh-error { padding: 10px 16px; margin: 0; border-bottom: 1px solid var(--line); background: var(--panel); }
  @media (hover: hover) and (pointer: fine) {
    button:hover:not(:disabled), .download-link:hover, input[type=file]:not(:disabled)::file-selector-button:hover { background: var(--raised); }
    .gallery-app button.primary-action:hover:not(:disabled) { background: var(--primary-hover); }
    .artifact-row[aria-current="true"]:hover { background: var(--selected); }
    .create-item:hover { background: var(--raised); color: var(--text); }
    .view-control button:hover { background: transparent; }
    .view-control button:hover:not([data-active]), .library-filters button:hover:not([aria-pressed="true"]) { color: var(--text); background: transparent; }
  }
  @media (max-width: 1100px) {
    .gallery-layout { grid-template-columns: 232px minmax(0, 1fr); }
    .library-heading { width: 200px; }
    .detail-header { gap: 8px; padding-left: 12px; }
    .account-name { display: none; }
  }
  @media (max-width: 760px) {
    .agent-onboarding { padding: 24px 20px; }
    .agent-onboarding input, .agent-onboarding textarea { font-size: 16px; }
    .agent-onboarding button { min-height: 44px; }
    .app-header { min-height: 52px; padding: 6px 12px; gap: 10px; }
    .library-heading { width: auto; flex: 1; gap: 16px; }
    .create-item { width: 44px; height: 44px; }
    .app-header { flex-wrap: wrap; }
    .header-actions { flex-wrap: wrap; }
    .artifact-detail { margin: 0 8px 8px; }
    .header-context { display: none; }
    .header-actions { gap: 4px; }
    .header-actions .select-control { max-width: 130px; }
    .account { margin-left: 0; }
    .gallery-layout { display: flex; flex: 1; }
    .library-panel, .artifact-detail { width: 100%; flex: 1; }
    .library-panel { border-right: 0; }
    .artifact-row { min-height: 44px; }
    .artifact-name { font-size: 14px; }
    .back-library { display: inline-flex; padding: 0; width: 28px; flex-shrink: 0; color: var(--muted); }
    .detail-header { padding: 0 4px 0 8px; gap: 4px; }
    .detail-title h1 { font-size: 13px; }
    .detail-actions { gap: 2px; }
    .detail-actions .open-link { display: none; }
    .detail-header .view-control button { padding-inline: 6px; font-size: 12px; }
    .detail-actions > button { padding-inline: 8px; }
    .view-control { gap: 0; }
    .view-control button { padding-inline: 8px; }
    .link-settings { padding: 12px; }
    .script-fields > :is(input, label, .select-control) { max-width: 100%; }
    .link-settings label { flex: 1; min-width: 0; }
    .link-settings input { width: 100%; }
    .detail-disclosure { max-height: 45dvh; }
    .project-file-bar { padding-inline: 6px; }
    .source-actions { padding: 8px 12px; }
    .source-code-status { padding-inline: 12px; }
    .source-code-status .editor-shortcuts { display: none; }
    .script-activity, .artifact-execution { padding: 12px; }
    .project-import { padding: 16px; }
  }
  .more-actions { width: 32px; padding: 0; font-size: 24px; line-height: 1; }
  .mobile-open { display: none !important; }
  @media (max-width: 760px) { .mobile-open { display: block !important; } }
  .action-menu { padding: 4px; min-width: 170px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); box-shadow: 0 8px 28px #0002; }
  .action-menu :is([role=menuitem], [role=menuitemradio]) { display: block; padding: 8px 12px; border-radius: 6px; text-decoration: none; cursor: pointer; }
  .action-menu [role=menuitemradio] { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .action-menu [data-highlighted] { background: var(--raised); outline: none; }
  .menu-check { width: 9px; height: 5px; margin-top: -3px; flex-shrink: 0; border-left: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(-45deg); }
  .settings-panel { width: 100%; overflow: auto; }
  .settings-title { margin: 16px 20px 0; font-size: 15px; }
  .secret-controls { width: 100%; max-width: 680px; padding: 16px 20px 28px; }
  .settings-description { margin: 0 0 24px; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .secret-list-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .secret-list-header h3 { font-size: 12px; font-weight: 600; margin: 0; }
  .secret-list { margin: 0 0 24px; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .secret-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 8px 12px; }
  .secret-list li + li { border-top: 1px solid var(--line); }
  .secret-list code { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
  .secret-list button { height: 28px; min-height: 28px; font-size: 12px; }
  .secret-controls fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
  .secret-controls legend { padding: 0; margin-bottom: 12px; font-size: 12px; font-weight: 600; }
  .settings-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  .settings-fields label { display: flex; flex-direction: column; gap: 6px; color: var(--muted); font-size: 12px; }
  .settings-fields input { width: 100%; height: 36px; color: var(--text); }
  .settings-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
  .settings-actions button { min-height: 36px; }
  .settings-actions .destructive-action { color: var(--error); border-color: transparent; background: transparent; }
  .gallery-app .settings-actions .destructive-action.confirm { color: var(--panel); border-color: var(--error); background: var(--error); font-weight: 600; }
  .settings-actions .confirm-prompt { color: var(--text); font-size: 12px; }
  .settings-feedback { min-height: 20px; margin: 12px 0 0; color: var(--muted); font-size: 12px; }
  .script-panel .secret-controls { flex: 1; min-height: 0; overflow: auto; }
  @media (max-width: 760px) {
    .secret-controls { padding: 16px; }
    .settings-fields { grid-template-columns: minmax(0, 1fr); }
    .settings-fields input { height: 44px; font-size: 16px; }
    .settings-actions button, .secret-list-header button, .secret-list button { min-height: 44px; }
    .detail-actions { margin-left: 0; }
  }
  @media (pointer: coarse) {
    button, input, select, .download-link, summary { height: auto; min-height: 44px; }
    input[type=file] { min-height: 0; }
    input, select, textarea, .script-panel textarea { font-size: 16px; }
    .search-input, select { padding-block: 11px; }
    .clear-search { height: 44px; }
  }
`;
