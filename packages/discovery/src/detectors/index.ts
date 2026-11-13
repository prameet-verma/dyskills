import type { Detector } from "./types";
import { MANIFEST_DETECTORS } from "./manifest";

export * from "./types";
export { MANIFEST_DETECTORS } from "./manifest";

/** Every registered detector; later tasks append theirs here. */
export const ALL_DETECTORS: Detector[] = [...MANIFEST_DETECTORS];
