import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { startHttpServer } from "./http.js";

const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || "4242", 10);
const FRONTEND_PORT = parseInt(process.env.PORT || "3000", 10);

console.log("\n==========================================================");
console.log("   🚀 KHỞI ĐỘNG HỆ SINH THÁI NEURAL KNOWLEDGE STUDIO     ");
console.log("==========================================================");

// 1. Start Backend API Server
const backendServer = startHttpServer();

// 2. Start Next.js Frontend
const webDir = path.join(process.cwd(), "web");
const nextCmd = fs.existsSync(path.join(webDir, ".next")) ? "start" : "dev";
const nextProcess = spawn("npx", ["next", nextCmd, "-p", FRONTEND_PORT.toString()], {
  cwd: webDir,
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    PORT: FRONTEND_PORT.toString(),
  },
});

console.log(`\n   👉 Web UI (Next.js + shadcn/ui): http://localhost:${FRONTEND_PORT}`);
console.log(`   👉 Backend REST API (MCP Server): http://localhost:${BACKEND_PORT}`);
console.log("==========================================================\n");

function shutdown() {
  console.log("\n🛑 Đang dừng hệ thống Neural Knowledge Studio...");
  backendServer.close();
  nextProcess.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
