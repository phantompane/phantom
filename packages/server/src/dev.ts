import { startServer } from "./server.ts";

const port = 3001;

startServer({ port });

console.log(`phantom server dev listening on http://127.0.0.1:${port}`);
