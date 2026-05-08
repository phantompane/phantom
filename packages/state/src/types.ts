import { z } from "zod";

export const chatStatusSchema = z.enum([
  "idle",
  "running",
  "waitingForApproval",
  "failed",
  "archived",
]);

const projectRecordBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOpenedAt: z.string(),
});

const chatAttachmentRecordBaseSchema = z.object({
  name: z.string(),
  path: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});

const chatMessageRecordBaseSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(["user", "assistant", "event", "error"]),
  text: z.string(),
  attachments: z.array(chatAttachmentRecordBaseSchema).optional(),
  eventType: z.string().optional(),
  eventData: z.unknown().optional(),
  itemId: z.string().optional(),
  createdAt: z.string(),
});

const turnContextItemBaseSchema = z.object({
  name: z.string(),
  path: z.string(),
});

const recentProjectSkillRecordBaseSchema = z.object({
  path: z.string(),
  lastUsedAt: z.string(),
});

const recentProjectSkillsByProjectBaseSchema = z
  .record(z.string(), z.array(recentProjectSkillRecordBaseSchema))
  .default({});

const queuedMessageRecordBaseSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  text: z.string(),
  attachments: z.array(chatAttachmentRecordBaseSchema).optional(),
  effort: z.string().optional(),
  files: z.array(turnContextItemBaseSchema).optional(),
  model: z.string().optional(),
  serviceTier: z.enum(["fast", "flex"]).optional(),
  skills: z.array(turnContextItemBaseSchema).optional(),
  createdAt: z.string(),
});

const chatRecordBaseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  worktreeName: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
  codexThreadId: z.string().nullable(),
  title: z.string(),
  status: chatStatusSchema,
  activeTurnId: z.string().nullable().optional(),
  hasQueuedMessages: z.boolean().optional(),
  isDrainingQueuedMessages: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const nullableStringFromUnknownSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : null),
  z.string().nullable(),
);

const serveStateBaseSchema = z.object({
  version: z.literal(1),
  projects: z.array(projectRecordBaseSchema),
  chats: z.array(chatRecordBaseSchema),
  messages: z.array(chatMessageRecordBaseSchema),
  queuedMessages: z.array(queuedMessageRecordBaseSchema).default([]),
  recentProjectSkills: recentProjectSkillsByProjectBaseSchema,
  selectedProjectId: nullableStringFromUnknownSchema,
  selectedChatId: nullableStringFromUnknownSchema,
});

export type ChatStatus = z.infer<typeof chatStatusSchema>;
export type ChatAttachmentRecord = z.infer<
  typeof chatAttachmentRecordBaseSchema
>;
export type ProjectRecord = z.infer<typeof projectRecordBaseSchema>;
export type ChatMessageRecord = z.infer<typeof chatMessageRecordBaseSchema>;
export type QueuedMessageRecord = z.infer<typeof queuedMessageRecordBaseSchema>;
export type RecentProjectSkillRecord = z.infer<
  typeof recentProjectSkillRecordBaseSchema
>;
export type RecentProjectSkillsByProject = z.infer<
  typeof recentProjectSkillsByProjectBaseSchema
>;
export type ChatRecord = z.infer<typeof chatRecordBaseSchema>;
export type ServeState = z.infer<typeof serveStateBaseSchema>;

export const projectRecordSchema: z.ZodType<ProjectRecord> =
  projectRecordBaseSchema.passthrough();
export const chatMessageRecordSchema: z.ZodType<ChatMessageRecord> =
  chatMessageRecordBaseSchema.passthrough();
export const queuedMessageRecordSchema: z.ZodType<QueuedMessageRecord> =
  queuedMessageRecordBaseSchema.passthrough();
export const recentProjectSkillRecordSchema: z.ZodType<RecentProjectSkillRecord> =
  recentProjectSkillRecordBaseSchema.passthrough();
export const chatRecordSchema: z.ZodType<ChatRecord> =
  chatRecordBaseSchema.passthrough();
export const serveStateSchema: z.ZodType<ServeState> = z
  .object({
    version: z.literal(1),
    projects: z.array(projectRecordSchema),
    chats: z.array(chatRecordSchema),
    messages: z.array(chatMessageRecordSchema),
    queuedMessages: z.array(queuedMessageRecordSchema).default([]),
    recentProjectSkills: z
      .record(z.string(), z.array(recentProjectSkillRecordSchema))
      .default({}),
    selectedProjectId: nullableStringFromUnknownSchema,
    selectedChatId: nullableStringFromUnknownSchema,
  })
  .passthrough();
