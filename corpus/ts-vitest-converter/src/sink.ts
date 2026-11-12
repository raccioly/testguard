export interface LogEntry {
  category: string;
  from: string;
  to: string;
  quantity: number;
  result: number;
  timestamp: number;
}

const entries: LogEntry[] = [];

export function write(entry: LogEntry): void {
  entries.push(entry);
}

export function now(): number {
  return Date.now();
}
