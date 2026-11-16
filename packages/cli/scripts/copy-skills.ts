import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SOURCE = resolve(import.meta.dirname, "../../../skills/dynamic-skill-bootstrap/SKILL.md");
const TARGET = resolve(import.meta.dirname, "../skills/dynamic-skill-bootstrap/SKILL.md");

// Byte-identical copy so the published tarball carries exactly the repository's bootstrap skill.
mkdirSync(dirname(TARGET), { recursive: true });
copyFileSync(SOURCE, TARGET);
