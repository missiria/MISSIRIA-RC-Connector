# Asset sources

`social.html`, `terminal.html` and `chat.html` are the mockups rendered to the PNGs in
`docs/assets/`. The chat mockup is a generic assistant UI (not a screenshot of any product);
names and messages are fictional. Re-render with Playwright, e.g.:

```js
// node render.mjs — viewport 1280×640 (social), 1200×760 (terminal), 1200×800 (chat), scale 2
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
await page.goto('file://' + path); await page.screenshot({ path: 'chat-example.png' });
```

`social-preview.png` is the 1280×640 GitHub social preview (repository Settings → Social preview).
