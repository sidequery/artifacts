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
  input { background: var(--page); }
  button:disabled, select:disabled { opacity: .45; cursor: default; }
  :is(button, input, select, textarea, summary, a):focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  button, a { -webkit-tap-highlight-color: transparent; }
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
  .connection-status { padding: 0 12px 8px; margin: 0; color: var(--muted); font-size: 12px; }
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
  .row-kind { flex-shrink: 0; color: var(--subtle); font-size: 11px; }
  .workspace-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--subtle); font-size: 11px; }
  .library-footer { padding: 8px 12px; color: var(--subtle); font-size: 11px; }
  .library-count { padding: 8px 12px; color: var(--subtle); font-size: 11px; }
  .artifact-detail { display: flex; flex-direction: column; min-width: 0; min-height: 0; margin: 0 6px 6px 0; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .detail-header { display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 10px 16px; flex-shrink: 0; flex-wrap: nowrap; border-bottom: 1px solid var(--line); }
  .detail-title { min-width: 0; flex: 1; }
  .detail-eyebrow { margin: 0 0 2px; color: var(--muted); font-size: 11px; }
  .detail-title h1 { margin: 0; font-size: 15px; line-height: 1.3; font-weight: 600; letter-spacing: -.35px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-title h1:focus { outline: none; }
  .detail-actions { display: flex; align-items: center; gap: 4px; flex-wrap: nowrap; justify-content: flex-end; flex-shrink: 0; }
  .detail-actions > :is(button, a) { white-space: nowrap; }
  .download-link { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; min-height: 32px; line-height: 20px; padding: 5px 10px; border: 1px solid transparent; border-radius: 8px; text-decoration: none; }
  .detail-actions .open-link { margin-left: 6px; border-color: var(--line); }
  .view-control { display: flex; align-items: center; gap: 2px; overflow-x: auto; min-width: 0; }
  .view-control button { padding: 5px 10px; color: var(--muted); flex-shrink: 0; border-radius: 0; border-bottom: 2px solid transparent; height: 40px; }
  .view-control button[data-active] { color: var(--text); border-bottom-color: var(--text); background: transparent; }
  .revision-control { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
  .version-select { width: 140px; max-width: 140px; }
  .version-select select { border-color: transparent; background: transparent; color: var(--text); }
  .detail-actions button[aria-expanded="true"] { background: var(--raised); }
  .back-library { display: none; }
  .detail-disclosure { flex-shrink: 0; max-height: 42vh; overflow: auto; background: var(--panel); border-bottom: 1px solid var(--line); }
  .link-settings, .script-fields { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
  .link-settings { padding: 12px 20px; }
  .link-settings label, .script-fields label { display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; color: var(--muted); font-size: 12px; }
  .link-settings :is(button, .download-link), .script-panel button { border-color: var(--line); background: var(--raised); }
  .library-move { padding: 12px 20px; }
  .library-move p { margin: 0 0 10px; max-width: 720px; }
  .library-move button { border-color: var(--line); }
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
  .deployment-status { margin: 6px 0 0; color: var(--muted); }
  .save-feedback { padding: 8px 16px; flex-shrink: 0; max-height: 30vh; overflow: auto; }
  .save-feedback p { margin: 0 0 6px; }
  .save-feedback button { height: auto; text-align: left; text-decoration: underline; }
  .save-feedback pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .agent-onboarding { width: 100%; max-width: 600px; margin: auto; padding: 32px; }
  .agent-onboarding h2 { font-size: 24px; letter-spacing: -.6px; margin: 0 0 8px; }
  .agent-onboarding p { color: var(--muted); }
  .agent-onboarding details { border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-top: 24px; }
  .agent-onboarding textarea { border: 1px solid var(--line); border-radius: 8px; padding: 12px; resize: vertical; }
  .agent-onboarding label { display: block; margin-top: 16px; }
  .agent-onboarding input, .agent-onboarding textarea { display: block; width: 100%; background: var(--raised); }
  .agent-onboarding textarea { min-height: 100px; }
  .live-data-note { padding: 8px 16px; margin: 0; border-bottom: 1px solid var(--line); color: var(--muted); }
  .artifact-execution fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  .project-import { padding: 16px 20px; max-height: 50vh; overflow: auto; }
  .project-import label { display: block; margin: 8px 0; }
  .project-import h2 { margin: 0 0 8px; font-size: 16px; }
  .project-import input { background: var(--raised); }
  .project-import input[type=file] { height: auto; }
  .project-import pre { max-height: 160px; overflow: auto; white-space: pre-wrap; }
  .source-actions .source-readonly { margin-right: auto; }
  .save-conflict { flex-shrink: 0; padding: 8px 16px; max-height: 35vh; overflow: auto; }
  .save-conflict button { border-color: var(--line); margin-right: 8px; }
  .script-panel label { color: var(--muted); font-size: 12px; }
  .script-panel :is(input, select) { color: var(--text); }
  .project-editor { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
  .project-file-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .project-file-bar button { background: transparent; border-color: transparent; font: 12px/20px "SFMono-Regular", Consolas, monospace; }
  .project-file-bar button[aria-pressed="true"] { background: var(--raised); }
  .source-code-editor { display: flex; flex-direction: column; flex: 1; min-height: 180px; min-width: 0; }
  .source-code-surface { flex: 1; min-height: 0; min-width: 0; }
  .source-code-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 16px; border-top: 1px solid var(--line); color: var(--subtle); font-size: 11px; flex-shrink: 0; }
  .project-file-management, .project-dependencies { flex-shrink: 0; border-top: 1px solid var(--line); padding: 0 16px; max-height: 35vh; overflow: auto; }
  .project-file-management > div { padding-bottom: 10px; }
  .project-file-management details { margin: 0; }
  .project-file-management p { margin: 6px 0; }
  .script-panel textarea, .artifact-execution textarea { display: block; width: 100%; min-height: 80px; margin: 6px 0 12px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font: 13px/1.6 "SFMono-Regular", Consolas, monospace; resize: vertical; }
  summary { cursor: pointer; min-height: 32px; padding-block: 5px; color: var(--text); }
  .script-panel pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; border: 1px solid var(--line); background: var(--panel); }
  .script-activity, .artifact-execution { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px; }
  .script-activity p { color: var(--muted); }
  .script-activity label { display: block; }
  .script-activity details + details { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 8px; }
  .artifact-execution label { display: inline-flex; flex-direction: column; gap: 4px; margin: 8px 12px 8px 0; }
  .artifact-execution label:has(textarea) { display: flex; margin-right: 0; }
  .artifact-execution button { border-color: var(--line); }
  .artifact-execution table { border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 12px; width: 100%; }
  .artifact-execution :is(td, th) { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  .artifact-execution p { color: var(--muted); }
  .muted { color: var(--muted); }
  .artifact-stage { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .source-stage { display: flex; flex: 1; min-width: 0; min-height: 0; }
  .preview-stage { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; background: var(--panel); }
  .preview-frame { display: block; width: 100%; height: 100%; border: 0; background: var(--panel); }
  .preview-loading { position: absolute; inset: 0; display: grid; place-items: center; background: var(--page); color: var(--muted); pointer-events: none; }
  .state-message { margin: 0; padding: 12px; color: var(--muted); }
  .library-empty { padding: 20px 12px; }
  .library-empty p { margin: 0 0 8px; color: var(--muted); }
  .library-empty button { border-color: var(--line); }
  .empty-detail { margin: auto; max-width: 400px; padding: 24px; text-align: center; }
  .empty-detail h2 { margin: 0 0 8px; font-size: 18px; font-weight: 500; }
  .empty-detail p { margin: 0; color: var(--muted); }
  .error-message { color: var(--error); }
  .source-form > .error-message, .script-panel > .error-message { margin: 0; padding: 8px 16px; flex-shrink: 0; }
  .refresh-error { padding: 10px 16px; margin: 0; border-bottom: 1px solid var(--line); background: var(--panel); }
  @media (hover: hover) and (pointer: fine) {
    button:hover:not(:disabled), .download-link:hover { background: var(--raised); }
    .gallery-app button.primary-action:hover:not(:disabled) { background: var(--primary-hover); }
    .artifact-row[aria-current="true"]:hover { background: var(--selected); }
    .create-item:hover { background: var(--raised); color: var(--text); }
    .view-control button:hover:not([data-active]), .library-filters button:hover:not([aria-pressed="true"]) { color: var(--text); background: transparent; }
  }
  @media (max-width: 1100px) {
    .gallery-layout { grid-template-columns: 232px minmax(0, 1fr); }
    .library-heading { width: 200px; }
    .detail-header { gap: 8px; padding-inline: 12px; }
    .detail-actions { max-width: 300px; }
    .revision-control > span:not(.select-control) { display: none; }
    .account-name { display: none; }
  }
  @media (max-width: 760px) {
    .app-header { min-height: 52px; padding: 6px 12px; gap: 10px; }
    .library-heading { width: auto; flex: 1; gap: 16px; }
    .create-item { width: 44px; height: 44px; }
    .app-header { flex-wrap: wrap; }
    .header-actions { flex-wrap: wrap; }
    .artifact-detail { margin: 0 4px 4px; }
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
    .detail-header { padding: 4px 8px; gap: 4px; }
    .detail-actions { max-width: none; }
    .detail-title h1 { font-size: 13px; }
    .detail-actions .open-link { display: none; }
    .detail-header .view-control button { padding-inline: 6px; font-size: 12px; }
    .detail-actions > button { padding-inline: 8px; }
    .version-select { width: 150px; max-width: 150px; }
    .version-select select { padding-left: 6px; }
    .view-control { gap: 0; }
    .view-control button { padding-inline: 8px; }
    .revision-control { min-width: 0; margin-left: auto; }
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
  }
  .more-actions { width: 32px; padding: 0; font-size: 24px; line-height: 1; }
  .mobile-open { display: none !important; }
  @media (max-width: 760px) { .mobile-open { display: block !important; } }
  .action-menu { padding: 4px; min-width: 170px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); box-shadow: 0 8px 28px #0002; }
  .action-menu [role=menuitem] { display: block; padding: 8px 12px; border-radius: 6px; text-decoration: none; cursor: pointer; }
  .action-menu [data-highlighted] { background: var(--raised); outline: none; }
  .settings-panel { width: 100%; overflow: auto; }
  .settings-title { margin: 16px 20px 0; font-size: 15px; }
  .schedule-summary { padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .schedule-summary h2, .run-history h2 { margin: 0 0 8px; font-size: 15px; }
  .schedule-form { padding-block: 12px; }
  .run-history { margin-top: 24px; overflow-x: auto; }
  @media (max-width: 760px) {
    .detail-actions { margin-left: 0; }
    .revision-control { padding-bottom: 4px; }
  }
  @media (pointer: coarse) {
    button, input, select, .download-link, summary { height: auto; min-height: 44px; }
    input, select, textarea, .script-panel textarea { font-size: 16px; }
    .search-input { padding-block: 11px; }
    .clear-search { height: 44px; }
  }
`;
