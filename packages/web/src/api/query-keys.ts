export const queryKeys = {
  auth: ["auth"] as const,
  models: ["models"] as const,
  projects: ["projects"] as const,
  projectData: (projectId: string, sync: boolean) =>
    ["projects", projectId, "data", { sync }] as const,
  chat: (chatId: string) => ["chats", chatId] as const,
  messages: (chatId: string) => ["chats", chatId, "messages"] as const,
  chatSkills: (chatId: string) => ["chats", chatId, "skills"] as const,
  fileSearch: (chatId: string, query: string) =>
    ["chats", chatId, "files", query] as const,
};
