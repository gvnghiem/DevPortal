<p align="center"><img src="DevPortalByGau.jpg" alt="DevPortal by Gau" width="640"></p>

# DevPortal

A dev portal for writing, running, and visualizing code. Playgrounds for JavaScript and Python, switched from the header.

## Playground

Open `index.html` in any browser (no build step, no dependencies).

**Editor**
- Line numbers, Tab indent, auto-indent (after `:` in Python, `{` in JavaScript), `Ctrl/⌘ + Enter` to run, optional auto-run
- **Import** a `.js` or `.py` file (button or drag-and-drop; the language switches automatically), **Save** to a file, or **Copy** to the clipboard
- Editable file name; your code, file name and theme are remembered in the browser

**Preview**
- Runs in a sandboxed iframe with a ready-made `<canvas id="canvas">` and `<div id="app">`
- Console tab captures `console.*`, uncaught errors (with line numbers) and promise rejections
- A `THEME` object (`bg, fg, muted, accent, accent2, ok, warn, err, fade(alpha)`) follows the selected theme

**Examples**
- Basics: console, async & errors
- Canvas & animation: bouncing balls, sine waves, particle trail, bubble-sort visualizer
- Data, maps & flow: traffic-flow nodes & roads (click to close intersections), world map with live connections, live trend chart, bar race
- UI & media: interactive counter, video embedder (YouTube / Vimeo / .mp4)

**Themes**: Black, Dark, Light, Neon · Matrix (digital rain), Neon · Jarvis (HUD rings & grid), Heaven (gold, glass panels, light rays and sparkles). Animated backgrounds respect `prefers-reduced-motion`.

## Python
Python runs in your browser using [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly), inside the same sandboxed preview.
- `print()` and errors (with a clean traceback) go to the Console tab; the runtime loads once (~10 MB, then cached by the browser) and stays warm between runs
- Packages load automatically on import (numpy, pandas, matplotlib, scipy, ...). `micropip` works for pure-Python packages
- `show_html(html)` puts HTML on the page, `canvas` is a ready-made canvas (draw on it through the JS bridge), and `THEME` follows the portal theme
- matplotlib figures render into the preview and pick up the theme colours
- Examples: hello, algorithms & timing, errors, canvas particles, matplotlib trend / scatter / Mandelbrot, pandas summary
- `input()` isn't available; Stop discards the runtime (the next run reloads it from cache)

## Notes
- Code runs in `iframe sandbox="allow-scripts allow-popups"`, isolated from the page.
- The video embedder and the Python runtime need internet access and a normal browser context (local file or GitHub Pages); Pyodide loads from `cdn.jsdelivr.net`.
