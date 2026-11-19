import { resolve } from "node:path";
import { copyAtomic } from "./copy-atomic";

const SOURCE = resolve(import.meta.dirname, "../../../skills/dynamic-skill-bootstrap/SKILL.md");
const TARGET = resolve(import.meta.dirname, "../skills/dynamic-skill-bootstrap/SKILL.md");

// Byte-identical copy so the published tarball carries exactly the repository's bootstrap skill.
copyAtomic(SOURCE, TARGET);
