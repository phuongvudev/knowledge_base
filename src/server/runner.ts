import { spawn } from "node:child_process";
import path from "node:path";
import { startHttpServer } from "./http.js";

const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || "4242", 10);
const FRONTEND_PORT = parseInt(process.env.PORT || "3000", 10);

console.log("\n==========================================================");
console.log("   🚀 KHỞI ĐỘNG HỆ SINH THÁI NEURAL KNOWLEDGE STUDIO     ");
console.log("==========================================================");

// 1. Start Backend API Server (Port 4242)
const backendServer = startHttpServer(undefined, BACKEND_PORT);

// 2. Start Next.js Frontend (Port 3000)
const webDir = path.join(process.cwd(), "web");
const nextProcess = spawn("npx", ["next", "dev", "-p", FRONTEND_PORT.toString()], {
  cwd: webDir,
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    PORT: FRONTEND_PORT.toString(),
  },
});

console.log(`\n   👉 Web UI (Next.js Dev Server): http://localhost:${FRONTEND_PORT}`);
console.log(`   👉 Web UI (Embedded Production): http://localhost:${BACKEND_PORT}`);
console.log(`   👉 Backend REST API: http://localhost:${BACKEND_PORT}/api`);
console.log("==========================================================\n");

function shutdown() {
  console.log("\n🛑 Đang dừng hệ thống Neural Knowledge Studio...");
  try {
    backendServer.close();
  } catch {}
  try {
    nextProcess.kill("SIGTERM");
  } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
