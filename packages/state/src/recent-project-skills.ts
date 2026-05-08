import type {
  RecentProjectSkillRecord,
  RecentProjectSkillsByProject,
} from "./types.ts";

export const maxRecentProjectSkillsPerProject = 5;

export function rememberRecentProjectSkillSelection(
  recordsByProject: RecentProjectSkillsByProject,
  projectId: string,
  skillPath: string,
  lastUsedAt = new Date().toISOString(),
  limit = maxRecentProjectSkillsPerProject,
): RecentProjectSkillsByProject {
  const nextProjectRecords = [
    { path: skillPath, lastUsedAt },
    ...(recordsByProject[projectId] ?? []).filter(
      (record) => record.path !== skillPath,
    ),
  ]
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, Math.max(0, limit));

  return {
    ...recordsByProject,
    [projectId]: nextProjectRecords,
  };
}

export function getRecentProjectSkillRecords(
  recordsByProject: RecentProjectSkillsByProject,
  projectId: string,
): RecentProjectSkillRecord[] {
  return recordsByProject[projectId] ?? [];
}
