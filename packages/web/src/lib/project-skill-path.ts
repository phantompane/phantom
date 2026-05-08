export function getProjectSkillPathIdentity(
  skillPath: string,
  projectRoots: readonly string[],
): string {
  const normalizedSkillPath = normalizeSlashPath(skillPath.trim());
  for (const root of [...projectRoots].sort(
    (left, right) => right.length - left.length,
  )) {
    const normalizedRoot = normalizeSlashPath(root);
    const rootPrefix = normalizedRoot.endsWith("/")
      ? normalizedRoot
      : `${normalizedRoot}/`;
    if (normalizedSkillPath.startsWith(rootPrefix)) {
      return normalizedSkillPath.slice(rootPrefix.length);
    }
  }
  return normalizedSkillPath;
}

function normalizeSlashPath(path: string): string {
  return path.replaceAll("\\", "/");
}
