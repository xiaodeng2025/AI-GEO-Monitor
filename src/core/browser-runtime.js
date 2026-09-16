import { chromium } from 'playwright';

export const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 1100 });

/** Browser lifecycle only. It deliberately knows no platform selectors. */
export class BrowserRuntime {
  constructor({ profileDir, headless = false, slowMo = 0, viewport = DEFAULT_VIEWPORT, args = undefined }) {
    this.profileDir = profileDir;
    this.headless = headless;
    this.slowMo = slowMo;
    this.viewport = viewport;
    this.args = args;
    this.context = null;
  }

  contextOptions() {
    const options = {
      headless: this.headless,
      slowMo: this.slowMo,
      viewport: this.viewport
    };
    if (this.args !== undefined) options.args = this.args;
    return options;
  }

  async open() {
    if (!this.context) {
      this.context = await chromium.launchPersistentContext(this.profileDir, this.contextOptions());
    }
    return this.context;
  }

  async newPage() {
    const context = await this.open();
    return context.newPage();
  }

  async close() {
    await this.context?.close();
    this.context = null;
  }
}
