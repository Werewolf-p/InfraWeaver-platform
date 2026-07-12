/**
 * True when the keyboard event (or element) targets a control the user is
 * typing in — inputs, textareas, selects, and contenteditable regions — so
 * global single-key shortcuts know to stay out of the way.
 *
 * Accepts either an event (native or React synthetic) or the target itself:
 * `isTypingTarget(event)` and `isTypingTarget(event.target)` are equivalent.
 */
export function isTypingTarget(source: Event | { target: EventTarget | null } | EventTarget | null | undefined): boolean {
  if (!source || typeof HTMLElement === "undefined") return false;
  const target = source instanceof EventTarget ? source : source.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export interface KeyboardShortcut {
  keys: string[];
  description: string;
  category: "Navigation" | "Actions" | "Views";
}

export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  { keys: ["?"], description: "Show keyboard shortcuts", category: "Navigation" },
  { keys: ["⌘", "K"], description: "Open command palette / global search", category: "Navigation" },
  { keys: ["⌘", "R"], description: "Refresh current page data", category: "Actions" },
  { keys: ["⌘", "/"], description: "Focus search", category: "Navigation" },
  // "Go to" page chords (G then a letter) are derived from nav-config and
  // rendered separately by the shortcuts modal — keeping them here too would
  // let the two lists drift apart.
  { keys: ["Esc"], description: "Close modal / panel", category: "Actions" },
  { keys: ["R"], description: "Refresh current view", category: "Actions" },
  { keys: ["["], description: "Previous pod in Logs view", category: "Actions" },
  { keys: ["]"], description: "Next pod in Logs view", category: "Actions" },
  { keys: ["Shift", "P"], description: "Pause / resume live logs", category: "Actions" },
  { keys: ["↑", "↓"], description: "Move through search results", category: "Actions" },
  { keys: ["Enter"], description: "Select highlighted result", category: "Actions" },
];
