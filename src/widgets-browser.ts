// Browser entry: exposes src/widgets.ts as window.WidgetLib.
// Generated — do not hand-edit. Rebuild with:
//   bun build src/widgets-browser.ts --outfile public/widgets-lib.js --target browser --format iife
import * as W from "./widgets";
(globalThis as any).WidgetLib = W;
