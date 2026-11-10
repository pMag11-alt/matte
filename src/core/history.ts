/** Undo/redo over immutable snapshots. Snapshots are JSON strings, so identical states dedupe for free. */
export class History {
  private stack: string[] = [];
  private index = -1;

  constructor(private readonly limit = 200) {}

  push(snapshot: string): void {
    if (this.stack[this.index] === snapshot) return;
    this.stack.length = this.index + 1;
    this.stack.push(snapshot);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
  }

  undo(): string | null {
    if (!this.canUndo) return null;
    return this.stack[--this.index];
  }

  redo(): string | null {
    if (!this.canRedo) return null;
    return this.stack[++this.index];
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }

  clear(): void {
    this.stack = [];
    this.index = -1;
  }
}
