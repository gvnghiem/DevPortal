# DevPortal

A dev portal for writing, running, and visualizing code. Starting with a JavaScript playground.

## JavaScript Playground

Open `index.html` in any browser (no build step, no dependencies).

- Editor with line numbers, Tab indent, `Ctrl/⌘ + Enter` to run, optional auto-run
- Sandboxed iframe preview with a ready-made `<canvas id="canvas">` and `<div id="app">`
- Console tab capturing `console.*`, uncaught errors (with line numbers) and promise rejections
- Built-in examples: canvas animations, DOM, sorting visualizer, async/errors

Code runs in an `iframe sandbox="allow-scripts"`, isolated from the page.
