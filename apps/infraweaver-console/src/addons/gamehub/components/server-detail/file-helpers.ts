import { fetchJson } from "./utils";

export interface FileContentResponse {
  path: string;
  content: string;
}

export type PropertyLine =
  | { type: "pair"; key: string; value: string }
  | { type: "comment" | "blank"; raw: string };

export function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingFileError(error: unknown) {
  const message = safeErrorMessage(error).toLowerCase();
  return ["no such file", "not found", "enoent", "cannot stat"].some((needle) =>
    message.includes(needle),
  );
}

export function isMinecraftGameType(gameType: string) {
  const normalized = (gameType ?? "").toLowerCase();
  return normalized === "minecraft" || normalized.includes("minecraft");
}

export async function readServerFile(serverName: string, filePath: string) {
  const response = await fetchJson<FileContentResponse>(
    `/api/game-hub/servers/${serverName}/files/content?path=${encodeURIComponent(filePath)}`,
  );
  return response.content;
}

export async function writeServerFile(serverName: string, filePath: string, content: string) {
  await fetchJson(`/api/game-hub/servers/${serverName}/files/content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, content }),
  });
}

export function parseJsonContent<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export async function readJsonServerFile<T>(
  serverName: string,
  filePath: string,
  fallback: T,
) {
  try {
    const content = await readServerFile(serverName, filePath);
    return parseJsonContent(content, fallback);
  } catch (error) {
    if (isMissingFileError(error)) return fallback;
    throw error;
  }
}

function separatorIndex(line: string) {
  for (let index = 0; index < line.length; index += 1) {
    if ((line[index] === "=" || line[index] === ":") && line[index - 1] !== "\\") {
      return index;
    }
  }
  return -1;
}

export function parseProperties(content: string): PropertyLine[] {
  return content.split(/\r\n|\r|\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return { type: "blank", raw: line };
    if (/^\s*[#!]/.test(line)) return { type: "comment", raw: line };
    const index = separatorIndex(line);
    if (index < 0) {
      return { type: "pair", key: trimmed, value: "" };
    }
    return {
      type: "pair",
      key: line.slice(0, index).trim(),
      value: line.slice(index + 1).trimStart(),
    };
  });
}

export function serializeProperties(lines: PropertyLine[]) {
  return lines
    .map((line) =>
      line.type === "pair" ? `${line.key}=${line.value}` : line.raw,
    )
    .join("\n");
}

export function propertiesToObject(lines: PropertyLine[]) {
  return Object.fromEntries(
    lines
      .filter((line): line is Extract<PropertyLine, { type: "pair" }> => line.type === "pair")
      .map((line) => [line.key, line.value]),
  );
}

export async function readPropertiesServerFile(serverName: string, filePath: string) {
  try {
    const content = await readServerFile(serverName, filePath);
    return propertiesToObject(parseProperties(content));
  } catch (error) {
    if (isMissingFileError(error)) return {} as Record<string, string>;
    throw error;
  }
}
