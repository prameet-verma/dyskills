/** Directory names whose entire subtree is treated as secret material. */
const SECRET_DIRS = new Set(["secrets"]);

/** Basename patterns of files that commonly hold credentials or private keys. */
const SECRET_NAMES: RegExp[] = [
  /^\.env$/,
  /^\.env\..+/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^credentials\.json$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
];

/**
 * Tells whether a repo-relative path may hold secrets and must never be read or indexed
 * (global constraint: repository content is untrusted and secrets are never read).
 *
 * @param rel - Repo-relative path; `\` and `/` separators are both accepted.
 * @returns True when the basename matches a secret pattern or any directory is `secrets`.
 */
export function isSecretPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p))) return true;
  return SECRET_NAMES.some((re) => re.test(name));
}
