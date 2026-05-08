import { Hono, type Context } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { createSseResponse, parseLastEventId } from "./event-hub.ts";
import { renderChatMessages } from "./markdown.ts";
import { getServeServices, maxAttachmentBytes } from "./services.ts";
import type {
  ApiErrorBody,
  CodexServiceTier,
  CodexTurnContextItem,
} from "./types.ts";

const contextItemSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

const attachmentSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const createProjectSchema = z.object({
  path: z.string().min(1, "Project path is required"),
});

const createChatSchema = z
  .object({
    name: z.string().optional(),
    base: z.string().optional(),
    githubTargetNumber: z.number().int().positive().optional(),
    initialMessage: z.string().optional(),
    serviceTier: z.enum(["fast", "flex"]).nullable().optional(),
    worktreeName: z.string().optional(),
    worktreePath: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.worktreePath !== undefined && !value.worktreePath.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Worktree path is required",
        path: ["worktreePath"],
      });
    }
    if (value.worktreeName !== undefined && value.worktreePath === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Worktree path is required",
        path: ["worktreePath"],
      });
    }
    if (
      value.githubTargetNumber !== undefined &&
      (value.worktreeName !== undefined || value.worktreePath !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "GitHub checkout target cannot be combined with worktree input",
        path: ["githubTargetNumber"],
      });
    }
  });

const worktreeSchema = z.object({
  name: z.string().min(1, "Worktree name is required"),
  path: z.string().optional(),
});

const deleteWorktreeSchema = worktreeSchema.extend({
  force: z.boolean().optional(),
  keepBranch: z.boolean().optional(),
});

const recentProjectSkillSchema = z.object({
  path: z.string().min(1, "Skill path is required"),
});

const sendMessageSchema = z.object({
  text: z.string().min(1, "Message text is required"),
  attachments: z.array(attachmentSchema).optional(),
  effort: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  serviceTier: z.enum(["fast", "flex"]).nullable().optional(),
  files: z.array(contextItemSchema).optional(),
  skills: z.array(contextItemSchema).optional(),
});

const chatMessageSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  role: z.enum(["user"]),
  text: z.string(),
  attachments: z.array(attachmentSchema).optional(),
  eventType: z.literal("chat.message.queued"),
  itemId: z.string().optional(),
  createdAt: z.string().min(1),
});

const queuedMessageSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string().min(1),
  attachments: z.array(attachmentSchema).optional(),
  effort: z.string().optional(),
  files: z.array(contextItemSchema).optional(),
  model: z.string().optional(),
  serviceTier: z.enum(["fast", "flex"]).optional(),
  skills: z.array(contextItemSchema).optional(),
  createdAt: z.string().min(1),
});

const restorePendingMessageSchema = z.object({
  message: chatMessageSchema,
  messageIndex: z.number().int().nonnegative(),
  queuedMessage: queuedMessageSchema,
  queuedMessageIndex: z.number().int().nonnegative(),
});

const steerMessageSchema = sendMessageSchema;
const queueMessageSchema = sendMessageSchema;

const approvalSchema = z.object({
  decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
});

const archiveChatSchema = z.object({
  archived: z.boolean(),
});

const chatQuerySchema = z.object({
  context: z.string().optional(),
  fileQuery: z.string().optional(),
});

const maxAttachmentMultipartBytes = maxAttachmentBytes + 64 * 1024;

function jsonError(c: Context, message: string, status: 400 | 404 = 400) {
  return c.json(
    {
      error: {
        message,
      },
    } satisfies ApiErrorBody,
    status,
  );
}

function handleApiError(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status: 400 | 404 =
    message.includes("not found") || message.includes("Not found") ? 404 : 400;
  return jsonError(c, message, status);
}

function jsonBody<TSchema extends z.ZodType>(schema: TSchema) {
  return validator("json", (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      return jsonError(
        c,
        result.error.issues[0]?.message ?? "Request body is invalid",
      );
    }
    return result.data as z.infer<TSchema>;
  });
}

function query<TSchema extends z.ZodType>(schema: TSchema) {
  return validator("query", (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      return jsonError(
        c,
        result.error.issues[0]?.message ?? "Request query is invalid",
      );
    }
    return result.data as z.infer<TSchema>;
  });
}

function optionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function optionalServiceTier(
  value: CodexServiceTier | null | undefined,
): CodexServiceTier | undefined {
  return value ?? undefined;
}

function contextItems(
  value: z.infer<typeof sendMessageSchema>["files"],
): CodexTurnContextItem[] | undefined {
  return value?.map((item) => ({
    name: item.name,
    path: item.path,
  }));
}

async function parseAttachmentUpload(c: Context) {
  const formData = await parseLimitedFormData(
    c.req.raw,
    maxAttachmentMultipartBytes,
  );
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("Attachment file is required");
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    mimeType: file.type,
    name: file.name,
    size: file.size,
  };
}

async function parseLimitedFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  const bytes = await readRequestBodyWithLimit(request, maxBytes);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return await new Request(request.url, {
    body,
    headers: request.headers,
    method: request.method,
  }).formData();
}

async function readRequestBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Attachment file is too large");
  }

  const body = request.body;
  if (!body) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("Attachment file is too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const rpcRoutes = new Hono()
  .get("/health", async (c) => {
    try {
      return c.json(await getServeServices().getHealth(), 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .get("/auth", async (c) => {
    try {
      return c.json({ auth: await getServeServices().readAuth() }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .get("/events", (c) => {
    const services = getServeServices();
    const stream = services.eventHub.subscribe(
      (event) => event.scope === "global",
      parseLastEventId(c.req.raw),
    );
    return createSseResponse(stream);
  })
  .get("/models", async (c) => {
    try {
      return c.json({ models: await getServeServices().listModels() }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .get("/projects", async (c) => {
    try {
      return c.json({ projects: await getServeServices().listProjects() }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post("/projects", jsonBody(createProjectSchema), async (c) => {
    try {
      const body = c.req.valid("json");
      const project = await getServeServices().addProject(body.path);
      return c.json({ project }, 201);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .delete("/projects/:projectId", async (c) => {
    try {
      await getServeServices().removeProject(c.req.param("projectId"));
      return c.json({}, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .get("/projects/:projectId/worktrees", async (c) => {
    try {
      const worktrees = await getServeServices().listProjectWorktrees(
        c.req.param("projectId"),
      );
      return c.json({ worktrees }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .get("/projects/:projectId/chats", async (c) => {
    try {
      const chats = await getServeServices().listChats(
        c.req.param("projectId"),
      );
      return c.json({ chats }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .get("/projects/:projectId/skills", async (c) => {
    try {
      const skills = await getServeServices().listProjectSkills(
        c.req.param("projectId"),
      );
      return c.json({ skills }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .get("/projects/:projectId/recent-skills", async (c) => {
    try {
      const recentSkills = await getServeServices().listRecentProjectSkills(
        c.req.param("projectId"),
      );
      return c.json({ recentSkills }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post(
    "/projects/:projectId/recent-skills",
    jsonBody(recentProjectSkillSchema),
    async (c) => {
      try {
        const body = c.req.valid("json");
        const recentSkills =
          await getServeServices().rememberRecentProjectSkill(
            c.req.param("projectId"),
            body.path,
          );
        return c.json({ recentSkills }, 200);
      } catch (error) {
        return handleApiError(c, error);
      }
    },
  )
  .get("/projects/:projectId/github/checkout-targets", async (c) => {
    try {
      const github = await getServeServices().listProjectGitHubCheckoutTargets(
        c.req.param("projectId"),
      );
      return c.json({ github }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post("/projects/:projectId/chats", jsonBody(createChatSchema), async (c) => {
    try {
      const body = c.req.valid("json");
      const chat = await getServeServices().createChat(
        c.req.param("projectId"),
        {
          name: body.name,
          base: body.base,
          githubTargetNumber: body.githubTargetNumber,
          initialMessage: body.initialMessage,
          serviceTier: optionalServiceTier(body.serviceTier),
          worktreeName: body.worktreeName,
          worktreePath: body.worktreePath,
        },
      );
      return c.json({ chat }, 201);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .delete(
    "/projects/:projectId/worktrees",
    jsonBody(deleteWorktreeSchema),
    async (c) => {
      try {
        const body = c.req.valid("json");
        const result = await getServeServices().deleteProjectWorktree(
          c.req.param("projectId"),
          {
            name: body.name,
            path: body.path,
            force: body.force,
            keepBranch: body.keepBranch,
          },
        );
        return c.json(result, 200);
      } catch (error) {
        return handleApiError(c, error);
      }
    },
  )
  .post(
    "/projects/:projectId/worktrees/sync",
    jsonBody(worktreeSchema),
    async (c) => {
      try {
        const body = c.req.valid("json");
        const result = await getServeServices().syncProjectWorktreeBranch(
          c.req.param("projectId"),
          {
            name: body.name,
            path: body.path,
          },
        );
        return c.json(result, 200);
      } catch (error) {
        return handleApiError(c, error);
      }
    },
  )
  .get("/chats/:chatId", query(chatQuerySchema), async (c) => {
    try {
      const services = getServeServices();
      const chatId = c.req.param("chatId");
      const requestQuery = c.req.valid("query");
      if (requestQuery.context === "approval") {
        const approval = await services.getPendingApproval(chatId);
        return c.json({ approval }, 200);
      }
      if (requestQuery.context === "skills") {
        const skills = await services.listSkills(chatId);
        return c.json({ skills }, 200);
      }
      if (requestQuery.fileQuery !== undefined) {
        const files = await services.searchFiles(
          chatId,
          requestQuery.fileQuery,
        );
        return c.json({ files }, 200);
      }
      const chat = await services.getChat(chatId);
      return c.json({ chat }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post("/chats/:chatId/archive", jsonBody(archiveChatSchema), async (c) => {
    try {
      const body = c.req.valid("json");
      const chat = await getServeServices().setChatArchived(
        c.req.param("chatId"),
        body.archived,
      );
      return c.json({ chat }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .get("/chats/:chatId/events", (c) => {
    const chatId = c.req.param("chatId");
    const services = getServeServices();
    const stream = services.eventHub.subscribe(
      (event) => event.scope === "global" || event.chatId === chatId,
      parseLastEventId(c.req.raw),
    );
    return createSseResponse(stream);
  })
  .get("/chats/:chatId/messages", async (c) => {
    try {
      const messages = await getServeServices().getMessages(
        c.req.param("chatId"),
      );
      return c.json({ messages: renderChatMessages(messages) }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post("/chats/:chatId/attachments", async (c) => {
    try {
      const attachment = await getServeServices().uploadAttachment(
        c.req.param("chatId"),
        await parseAttachmentUpload(c),
      );
      return c.json({ attachment }, 201);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post("/chats/:chatId/messages", jsonBody(sendMessageSchema), async (c) => {
    try {
      const body = c.req.valid("json");
      const chat = await getServeServices().sendMessage(c.req.param("chatId"), {
        attachments: body.attachments,
        effort: optionalString(body.effort),
        files: contextItems(body.files),
        model: optionalString(body.model),
        serviceTier: optionalServiceTier(body.serviceTier),
        skills: contextItems(body.skills),
        text: body.text,
      });
      return c.json({ chat }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .delete("/chats/:chatId/messages/:messageId", async (c) => {
    try {
      const result = await getServeServices().deletePendingMessage(
        c.req.param("chatId"),
        c.req.param("messageId"),
      );
      return c.json(result, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post(
    "/chats/:chatId/messages/:messageId/restore",
    jsonBody(restorePendingMessageSchema),
    async (c) => {
      try {
        const body = c.req.valid("json");
        const result = await getServeServices().restorePendingMessage(
          c.req.param("chatId"),
          body,
        );
        return c.json(result, 200);
      } catch (error) {
        return handleApiError(c, error);
      }
    },
  )
  .post("/chats/:chatId/interrupt", async (c) => {
    try {
      await getServeServices().interruptChat(c.req.param("chatId"));
      return c.json({}, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post("/chats/:chatId/steer", jsonBody(steerMessageSchema), async (c) => {
    try {
      const body = c.req.valid("json");
      const chat = await getServeServices().steerMessage(
        c.req.param("chatId"),
        {
          attachments: body.attachments,
          effort: optionalString(body.effort),
          files: contextItems(body.files),
          model: optionalString(body.model),
          serviceTier: optionalServiceTier(body.serviceTier),
          skills: contextItems(body.skills),
          text: body.text,
        },
      );
      return c.json({ chat }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post("/chats/:chatId/queue", jsonBody(queueMessageSchema), async (c) => {
    try {
      const body = c.req.valid("json");
      const chat = await getServeServices().queueMessage(
        c.req.param("chatId"),
        {
          attachments: body.attachments,
          effort: optionalString(body.effort),
          files: contextItems(body.files),
          model: optionalString(body.model),
          serviceTier: optionalServiceTier(body.serviceTier),
          skills: contextItems(body.skills),
          text: body.text,
        },
      );
      return c.json({ chat }, 200);
    } catch (error) {
      return handleApiError(c, error);
    }
  })
  .post(
    "/chats/:chatId/approvals/:requestId",
    jsonBody(approvalSchema),
    async (c) => {
      try {
        const body = c.req.valid("json");
        await getServeServices().answerApproval(
          c.req.param("chatId"),
          c.req.param("requestId"),
          {
            decision: body.decision,
          },
        );
        return c.json({}, 200);
      } catch (error) {
        return handleApiError(c, error);
      }
    },
  );

export type AppType = typeof rpcRoutes;
