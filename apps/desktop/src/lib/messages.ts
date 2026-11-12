import type { Message } from "./types";
export function compareSequences(a: string, b: string) {
  const left = BigInt(a),
    right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function mergeMessages(
  current: Message[],
  incoming: Message[],
): Message[] {
  const entries = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) entries.set(item.id, item);
  return [...entries.values()].sort((a, b) => compareSequences(a.seq, b.seq));
}
export function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || "")
      .join("")
      .toUpperCase() || "?"
  );
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
