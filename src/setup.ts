import fs from "fs";
import path from "path";
import os from "os";

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function runAutoSetup() {
  console.log("==========================================================");
  console.log("   🚀 KNOWLEDGE BASE — 1-CLICK MULTI-AGENT AUTO SETUP     ");
  console.log("==========================================================\n");

  const homeDir = os.homedir();
  const rootDir = process.cwd();
  const serverScript = path.join(rootDir, "dist", "index.js");
  const dbPath = path.join(rootDir, "data", "neural_knowledge.db");

  if (!fs.existsSync(serverScript)) {
    console.error("❌ File dist/index.js not found. Please run 'npm run build' first!");
    process.exit(1);
  }

  const serverConfig: McpServerConfig = {
    command: "node",
    args: [serverScript],
    env: {
      KB_DB_PATH: dbPath,
    },
  };

  const targets = [
    {
      name: "Claude Desktop",
      configPath: path.join(
        homeDir,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      ),
      createIfMissing: true,
    },
    {
      name: "Cursor IDE (Global)",
      configPath: path.join(homeDir, ".cursor", "mcp.json"),
      createIfMissing: true,
    },
    {
      name: "Windsurf Cascade",
      configPath: path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
      createIfMissing: false,
    },
    {
      name: "VS Code (Cline Extension)",
      configPath: path.join(
        homeDir,
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json"
      ),
      createIfMissing: false,
    },
  ];

  let configuredCount = 0;

  for (const target of targets) {
    const dir = path.dirname(target.configPath);

    // If app directory exists or createIfMissing is true
    if (fs.existsSync(dir) || target.createIfMissing) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        let existingJson: any = {};
        if (fs.existsSync(target.configPath)) {
          const raw = fs.readFileSync(target.configPath, "utf-8");
          try {
            existingJson = JSON.parse(raw);
          } catch {
            existingJson = {};
          }
        }

        if (!existingJson.mcpServers) {
          existingJson.mcpServers = {};
        }

        existingJson.mcpServers["knowledge-base"] = serverConfig;

        fs.writeFileSync(
          target.configPath,
          JSON.stringify(existingJson, null, 2),
          "utf-8"
        );
        console.log(`✅ [${target.name}] Configured successfully!`);
        console.log(`   Path: ${target.configPath}\n`);
        configuredCount++;
      } catch (err: any) {
        console.log(`⚠️  [${target.name}] Skipped: ${err.message}\n`);
      }
    } else {
      console.log(`⚪ [${target.name}] Not installed on this machine (Skipped)\n`);
    }
  }

  console.log("==========================================================");
  console.log(`🎉 Auto-setup completed for ${configuredCount} AI Agent(s)!`);
  console.log("👉 Antigravity: Already pre-installed globally.");
  console.log("👉 Simply RESTART your apps to start using Knowledge Base.");
  console.log("==========================================================\n");
}

runAutoSetup();
