/** Directory names whose entire subtree is treated as secret material (`.aws`: credentials, config). */
const SECRET_DIRS = new Set(["secrets", ".aws"]);

/**
 * Basename patterns of files that commonly hold credentials or private keys. Every pattern is a
 * literal anchored at one end with no nested or adjacent quantifiers, so matching is linear in the
 * basename length.
 */
const SECRET_NAMES: RegExp[] = [
  /^\.env$/,
  /^\.envrc$/,
  /^\.netrc$/,
  /\.pfx$/,
  /\.jks$/,
  /\.keystore$/,
  /^\.env\..+/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^credentials\.json$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  // Terraform variables and state hold provider credentials and resource secrets in clear text.
  /\.tfvars$/,
  /\.tfvars\.json$/,
  /\.tfstate$/,
  /\.tfstate\.backup$/,
  /^\.git-credentials$/,
  /^kubeconfig$/,
  /^\.htpasswd$/,
  /^\.pgpass$/,
];

/** Config and data extensions that make a `secrets.*` file secret (`secrets.ts` is source, not). */
const SECRETS_FILE_EXTS = new Set([
  "json",
  "yaml",
  "yml",
  "toml",
  "env",
  "ini",
  "properties",
  "txt",
  "conf",
  "cfg",
  "xml",
  // Encrypted forms (sops, git-crypt style) are still secret-bearing artefacts.
  "enc",
  "sops",
]);

/**
 * Tells whether a lowercased basename is a `secrets.<...>` config or data file. Secret when the
 * final extension is a config/data one (`secrets.yaml`, `secrets.prod.json`), or when the second
 * segment marks encryption (`secrets.enc.*`, `secrets.sops.*`, any final extension). Source files
 * (`secrets.ts`, `secrets.py`, `secrets.test.ts`) are not. Fail safe: an unlisted extension stays
 * visible only because it is plainly not config; every listed or encrypted form is hidden.
 * Linear: one `startsWith`, one `split`, set lookups.
 */
function isSecretsFile(name: string): boolean {
  if (!name.startsWith("secrets.")) return false;
  const segs = name.split(".");
  const last = segs[segs.length - 1] ?? "";
  const second = segs[1] ?? "";
  return SECRETS_FILE_EXTS.has(last) || second === "enc" || second === "sops";
}

/**
 * `[parent directory, basename]` pairs that are secret only together: `config.json` and `config`
 * are common names, but under `.docker/` and `.kube/` they hold registry and cluster credentials.
 */
const SECRET_FILES_IN_DIR: ReadonlyArray<readonly [string, string]> = [
  [".docker", "config.json"],
  [".kube", "config"],
];

/**
 * Tells whether a repo-relative path may hold secrets and must never be read or indexed
 * (global constraint: repository content is untrusted and secrets are never read).
 *
 * @param rel - Repo-relative path; `\` and `/` separators are both accepted.
 * @returns True (case-insensitively, as macOS/Windows filesystems are) when the basename matches a
 *   secret pattern, the parent and basename form a secret pair (`.docker/config.json`,
 *   `.kube/config`), or any directory is `secrets` or `.aws`.
 */
export function isSecretPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  const parent = (parts[parts.length - 2] ?? "").toLowerCase();
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p.toLowerCase()))) return true;
  if (SECRET_FILES_IN_DIR.some(([dir, file]) => parent === dir && name === file)) return true;
  if (isSecretsFile(name)) return true;
  return SECRET_NAMES.some((re) => re.test(name));
}
