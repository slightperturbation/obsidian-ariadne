/** Minimal hand-written mock of the `obsidian` module for Vitest. */

export class Plugin {}
export class PluginSettingTab {}
export class Setting {
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addDropdown(): this {
    return this;
  }
  addSlider(): this {
    return this;
  }
}
export class App {}
export class TFile {
  path = "";
  basename = "";
  extension = "md";
  stat = { mtime: 0, ctime: 0, size: 0 };
  parent: { path: string } | null = null;
}
export class WorkspaceLeaf {}
export class Modal {
  contentEl = { replaceChildren() {}, classList: { add() {} } } as unknown as HTMLElement;
  scope = { register() {} };
  constructor(public app: App) {}
  open(): void {}
  close(): void {}
}
export class Notice {
  constructor(public message?: string) {}
}
export const normalizePath = (p: string): string => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export class ItemView {
  constructor(public leaf: WorkspaceLeaf) {}
}
export class MarkdownView {}
export const Platform = {
  isMobile: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isDesktopApp: true,
  isPhone: false,
  isTablet: false,
};
