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
  { keys: ["G", "H"], description: "Go to Home", category: "Navigation" },
  { keys: ["G", "A"], description: "Go to Apps", category: "Navigation" },
  { keys: ["G", "P"], description: "Go to Pods", category: "Navigation" },
  { keys: ["G", "C"], description: "Go to Cluster", category: "Navigation" },
  { keys: ["G", "S"], description: "Go to Security", category: "Navigation" },
  { keys: ["G", "L"], description: "Go to Logs", category: "Navigation" },
  { keys: ["Esc"], description: "Close modal / panel", category: "Actions" },
  { keys: ["R"], description: "Refresh current view", category: "Actions" },
  { keys: ["["], description: "Previous pod in Logs view", category: "Actions" },
  { keys: ["]"], description: "Next pod in Logs view", category: "Actions" },
  { keys: ["Shift", "P"], description: "Pause / resume live logs", category: "Actions" },
  { keys: ["↑", "↓"], description: "Move through search results", category: "Actions" },
  { keys: ["Enter"], description: "Select highlighted result", category: "Actions" },
];
