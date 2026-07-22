/** Minimal leveled console logger. `info`/`debug` are gated by the debug setting. */
export class Logger {
  constructor(
    private prefix: string,
    private enabled = false,
  ) {}

  private stamp(level: string): string {
    return `[${this.prefix}] ${level}:`;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  info(...args: unknown[]): void {
    if (this.enabled) console.log(this.stamp("info"), ...args);
  }

  debug(...args: unknown[]): void {
    if (this.enabled) console.debug(this.stamp("debug"), ...args);
  }

  warn(...args: unknown[]): void {
    console.warn(this.stamp("warn"), ...args);
  }

  error(...args: unknown[]): void {
    console.error(this.stamp("error"), ...args);
  }
}
