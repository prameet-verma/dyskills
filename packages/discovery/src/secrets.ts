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
  /^secrets\./,
  /^kubeconfig$/,
  /^\.htpasswd$/,
  /^\.pgpass$/,
];

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
  return SECRET_NAMES.some((re) => re.test(name));
}
