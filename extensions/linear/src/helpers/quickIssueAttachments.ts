import { execFile } from "child_process";
import { readdir, stat } from "fs/promises";
import { homedir, tmpdir } from "os";
import path from "path";
import { promisify } from "util";

import { format } from "date-fns";

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tif", ".tiff"]);

export type UploadedAttachment = { name: string; assetUrl: string };
export type RecentScreenshot = { path: string; modifiedAt: Date };

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function appendAttachmentsToDescription(description: string, uploads: UploadedAttachment[]): string {
  const links = uploads.map(({ name, assetUrl }) => {
    const label = name.replace(/[[\]]/g, "");
    return isImagePath(name) ? `![${label}](${assetUrl})` : `[${label}](${assetUrl})`;
  });
  return [description.trim(), ...links].filter(Boolean).join("\n\n");
}

export async function findRecentScreenshots(directory: string, limit = 20): Promise<RecentScreenshot[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const images = entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".") && isImagePath(entry.name));
  const withTimes = await Promise.all(
    images.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      return { path: filePath, modifiedAt: (await stat(filePath)).mtime };
    }),
  );
  return withTimes.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()).slice(0, limit);
}

async function readDefault(domain: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", ["read", domain, key]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function expandHome(directory: string): string {
  return directory === "~" || directory.startsWith("~/") ? path.join(homedir(), directory.slice(1)) : directory;
}

/** Preference first, then CleanShot's export folder, then the macOS screenshot location, then the Desktop. */
export async function resolveScreenshotDirectory(preferred: string | undefined): Promise<string> {
  const directory =
    preferred?.trim() ||
    (await readDefault("pl.maketheweb.cleanshotx", "exportPath")) ||
    (await readDefault("com.apple.screencapture", "location")) ||
    path.join(homedir(), "Desktop");
  return expandHome(directory);
}

/** Writes an image on the clipboard to a temporary PNG. Returns undefined when the clipboard holds no image. */
export async function saveClipboardImage(): Promise<string | undefined> {
  const target = path.join(tmpdir(), `Clipboard ${format(new Date(), "yyyy-MM-dd 'at' HH.mm.ss")}.png`);
  const script = [
    "on run argv",
    "set png to the clipboard as «class PNGf»",
    "set f to open for access (POSIX file (item 1 of argv)) with write permission",
    "set eof f to 0",
    "write png to f",
    "close access f",
    "end run",
  ];
  try {
    await execFileAsync("/usr/bin/osascript", [...script.flatMap((line) => ["-e", line]), target]);
    return target;
  } catch {
    return undefined;
  }
}
