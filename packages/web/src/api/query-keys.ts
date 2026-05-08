export const queryKeys = {
  auth: ["auth"] as const,
  models: ["models"] as const,
  projects: ["projects"] as const,
  projectChats: (projectId: string) =>
    ["projects", projectId, "chats"] as const,
  projectGitHubCheckoutTargets: (projectId: string) =>
    ["projects", projectId, "github", "checkout-targets"] as const,
  projectRecentSkills: (projectId: string) =>
    ["projects", projectId, "recent-skills"] as const,
  projectSkills: (projectId: string) =>
    ["projects", projectId, "skills"] as const,
  projectWorktrees: (projectId: string) =>
    ["projects", projectId, "worktrees"] as const,
  chat: (chatId: string) => ["chats", chatId] as const,
  chatApproval: (chatId: string) => ["chats", chatId, "approval"] as const,
  messages: (chatId: string) => ["chats", chatId, "messages"] as const,
  chatSkills: (chatId: string) => ["chats", chatId, "skills"] as const,
  fileSearch: (chatId: string, query: string) =>
    ["chats", chatId, "files", query] as const,
};
