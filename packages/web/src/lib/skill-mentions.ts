export interface SkillMentionRecord {
  description?: string | null;
  displayName: string;
  enabled: boolean;
  name: string;
  path: string;
  shortDescription?: string | null;
}

export interface SkillMentionQuery {
  end: number;
  query: string;
  start: number;
}

export type SkillMentionKeyAction =
  | "complete"
  | "dismiss"
  | "first"
  | "last"
  | "next"
  | "previous";

export interface SkillMentionKeyEvent {
  altKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  key: string;
  keyCode?: number;
  metaKey?: boolean;
  shiftKey?: boolean;
}

const skillMentionNamePattern = /^[A-Za-z0-9._-]*$/;
const skillMentionNameCharacterPattern = /^[A-Za-z0-9._-]$/;
const skillMentionTokenPattern =
  /(^|[ \t\r\n])\$([A-Za-z0-9._-]+)(?=$|[ \t\r\n])/g;

export function getSkillMentionQuery(
  text: string,
  cursorPosition: number,
): SkillMentionQuery | null {
  const cursor = Math.max(0, Math.min(cursorPosition, text.length));
  const textBeforeCursor = text.slice(0, cursor);
  const markerIndex = textBeforeCursor.lastIndexOf("$");
  if (markerIndex < 0) {
    return null;
  }

  const previousCharacter = text[markerIndex - 1];
  if (
    previousCharacter !== undefined &&
    !isSkillMentionDelimiter(previousCharacter)
  ) {
    return null;
  }

  const query = textBeforeCursor.slice(markerIndex + 1);
  if (!skillMentionNamePattern.test(query)) {
    return null;
  }

  let tokenEnd = cursor;
  while (
    tokenEnd < text.length &&
    skillMentionNameCharacterPattern.test(text[tokenEnd] ?? "")
  ) {
    tokenEnd += 1;
  }

  const nextCharacter = text[tokenEnd];
  if (nextCharacter !== undefined && !isSkillMentionDelimiter(nextCharacter)) {
    return null;
  }

  return {
    end: tokenEnd,
    query,
    start: markerIndex,
  };
}

export function filterSkillMentions<TSkill extends SkillMentionRecord>(
  skills: TSkill[],
  query: string,
): TSkill[] {
  const normalizedQuery = query.trim().toLowerCase();
  const enabledSkills = getUniqueEnabledSkillsByName(skills);
  if (!normalizedQuery) {
    return enabledSkills;
  }

  return enabledSkills.filter((skill) => {
    const searchableText = [
      skill.name,
      skill.displayName,
      skill.shortDescription ?? "",
      skill.description ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return searchableText.includes(normalizedQuery);
  });
}

export function completeSkillMention<TSkill extends SkillMentionRecord>(
  text: string,
  mention: SkillMentionQuery,
  skill: TSkill,
): { cursorPosition: number; text: string } {
  const prefix = text.slice(0, mention.start);
  const suffix = text.slice(mention.end);
  const completedMention = `$${skill.name}`;
  const hasExistingDelimiter =
    suffix.length > 0 && isSkillMentionDelimiter(suffix[0] ?? "");
  const separator = hasExistingDelimiter ? "" : " ";
  const nextText = `${prefix}${completedMention}${separator}${suffix}`;
  const cursorOffset = hasExistingDelimiter ? 1 : separator.length;

  return {
    cursorPosition: prefix.length + completedMention.length + cursorOffset,
    text: nextText,
  };
}

export function getMentionedSkillPaths<TSkill extends SkillMentionRecord>(
  skills: TSkill[],
  text: string,
): string[] {
  const enabledSkillsByName = new Map<string, TSkill>();
  for (const skill of skills) {
    if (skill.enabled && !enabledSkillsByName.has(skill.name)) {
      enabledSkillsByName.set(skill.name, skill);
    }
  }

  const paths = new Set<string>();
  skillMentionTokenPattern.lastIndex = 0;
  for (const match of text.matchAll(skillMentionTokenPattern)) {
    const skillName = match[2];
    if (!skillName) {
      continue;
    }
    const skill = enabledSkillsByName.get(skillName);
    if (skill) {
      paths.add(skill.path);
    }
  }

  return [...paths];
}

export function hasSkillMentionText(text: string): boolean {
  skillMentionTokenPattern.lastIndex = 0;
  return skillMentionTokenPattern.test(text);
}

export function shouldOpenSkillMentionMenu(state: {
  composerText: string;
  dismissedText: string | null;
  hasSelectedProject: boolean;
  isComposerBlocked: boolean;
  query: SkillMentionQuery | null;
}): boolean {
  return (
    state.hasSelectedProject &&
    !state.isComposerBlocked &&
    state.query !== null &&
    state.dismissedText !== state.composerText
  );
}

export function getSkillMentionKeyAction(
  event: SkillMentionKeyEvent,
  hasOptions: boolean,
): SkillMentionKeyAction | null {
  if (event.isComposing || event.keyCode === 229) {
    return null;
  }

  if (hasSkillMentionKeyModifier(event)) {
    return null;
  }

  if (event.key === "Escape") {
    return "dismiss";
  }

  if (!hasOptions) {
    return null;
  }

  if (event.key === "ArrowDown") {
    return "next";
  }
  if (event.key === "ArrowUp") {
    return "previous";
  }
  if (event.key === "Home") {
    return "first";
  }
  if (event.key === "End") {
    return "last";
  }
  if (event.key === "Enter" || event.key === "Tab") {
    return "complete";
  }

  return null;
}

function isSkillMentionDelimiter(character: string): boolean {
  return /^[ \t\r\n]$/.test(character);
}

function hasSkillMentionKeyModifier(event: SkillMentionKeyEvent): boolean {
  return Boolean(
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
  );
}

function getUniqueEnabledSkillsByName<TSkill extends SkillMentionRecord>(
  skills: TSkill[],
): TSkill[] {
  const uniqueSkills: TSkill[] = [];
  const seenNames = new Set<string>();
  for (const skill of skills) {
    if (!skill.enabled || seenNames.has(skill.name)) {
      continue;
    }
    seenNames.add(skill.name);
    uniqueSkills.push(skill);
  }
  return uniqueSkills;
}
