/**
 * Triggers a client-side "save file" download for generated text content —
 * the Blob + object-URL + anchor-click pattern repeated across export flows.
 * Browser only: call from event handlers, not during render or on the server.
 */
export function downloadTextFile(filename: string, text: string, mime: string = "text/plain;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
