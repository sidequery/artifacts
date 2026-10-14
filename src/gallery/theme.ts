// Matches sidequery-mono/apps/web/app/app.css. Keep app chrome and editor
// on the same tokens; artifact previews retain their own authored styling.
// Light --focus is darker than the app.css amber so the ring keeps 3:1
// contrast against panel, page, and selected rows.
export const themeStyles = `
  :root {
    color-scheme: light;
    --page: #f6f5f1; --panel: #ffffff; --raised: #f0eee8;
    --selected: #e9e4d9; --line: #e7e4dd; --text: #1b1917;
    --muted: #6d665d; --subtle: #8b8378; --focus: #a86f00;
    --primary: #1b1917; --primary-text: #ffffff; --primary-hover: #2a2723;
    --error: #b91c1c; --success: #2f7a4b; --warning: #b06a00;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --syntax-keyword: #8250a0; --syntax-string: #326a42;
    --syntax-number: #98621b; --syntax-type: #216e78; --syntax-function: #654fb0;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page: #141312; --panel: #1c1a18; --raised: #25231f;
    --selected: #2e2b27; --line: #2e2b27; --text: #f4f2ee;
    --muted: #b5aea3; --subtle: #958c80; --focus: #f1bd5b;
    --primary: #f4f2ee; --primary-text: #141312; --primary-hover: #ffffff;
    --error: #f2a5a5; --success: #8fcca4; --warning: #f1bd5b;
    --syntax-keyword: #c4afe5; --syntax-string: #b6c6a0;
    --syntax-number: #d1b58e; --syntax-type: #a8c9c4; --syntax-function: #c6bfd5;
  }
`;
