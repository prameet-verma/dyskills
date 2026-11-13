import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Creates an empty temporary directory. */
export async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bootstrapper-"));
}

/** Writes `content` to `root/rel`, creating parent directories. */
export async function put(root: string, rel: string, content: string): Promise<void> {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Builds SKILL.md text with the given frontmatter fields and body. */
export function skillMd(name: string, description: string, body = "Body."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}
