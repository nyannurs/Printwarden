// What the type check (npm run types) can't know about the window: the desktop shell's
// bridge (_build/preload.cjs), the debugging handle (app.js), a test result (tools/), and
// Chromium's memory figure.
interface Window {
  desktop?: any;
  app: any;
  __bench?: any;
}
interface Navigator {
  readonly deviceMemory?: number;
}
