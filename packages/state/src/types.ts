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

const chatMessageRecordBaseSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(["user", "assistant", "event", "error"]),
  text: z.string(),
  eventType: z.string().optional(),
  itemId: z.string().optional(),
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
  selectedProjectId: nullableStringFromUnknownSchema,
  selectedChatId: nullableStringFromUnknownSchema,
});

export type ChatStatus = z.infer<typeof chatStatusSchema>;
export type ProjectRecord = z.infer<typeof projectRecordBaseSchema>;
export type ChatMessageRecord = z.infer<typeof chatMessageRecordBaseSchema>;
export type ChatRecord = z.infer<typeof chatRecordBaseSchema>;
export type ServeState = z.infer<typeof serveStateBaseSchema>;

export const projectRecordSchema: z.ZodType<ProjectRecord> =
  projectRecordBaseSchema.passthrough();
export const chatMessageRecordSchema: z.ZodType<ChatMessageRecord> =
  chatMessageRecordBaseSchema.passthrough();
export const chatRecordSchema: z.ZodType<ChatRecord> =
  chatRecordBaseSchema.passthrough();
export const serveStateSchema: z.ZodType<ServeState> = z
  .object({
    version: z.literal(1),
    projects: z.array(projectRecordSchema),
    chats: z.array(chatRecordSchema),
    messages: z.array(chatMessageRecordSchema),
    selectedProjectId: nullableStringFromUnknownSchema,
    selectedChatId: nullableStringFromUnknownSchema,
  })
  .passthrough();
