import type { Detector } from "./types";
import { MANIFEST_DETECTORS } from "./manifest";
import { STRUCTURE_DETECTORS } from "./structure";

export * from "./types";
export { MANIFEST_DETECTORS } from "./manifest";
export { STRUCTURE_DETECTORS } from "./structure";

/** Every registered detector; later tasks append theirs here. */
export const ALL_DETECTORS: Detector[] = [...MANIFEST_DETECTORS, ...STRUCTURE_DETECTORS];
