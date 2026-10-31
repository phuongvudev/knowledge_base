import fs from "fs";
import path from "path";
import os from "os";

interface TargetAgent {
  id: string;
  name: string;
  configPath: string;
  rulesSourcePath?: string;
  rulesDestPath?: string;
}

export function installPluginFor(targetArg: string) {
  const homeDir = os.homedir();
  const rootDir = process.cwd();
  const serverScript = path.join(rootDir, "dist", "index.js");
  const dbPath = path.join(rootDir, "data", "neural_knowledge.db");

  if (!fs.existsSync(serverScript)) {
    console.error("❌ Error: dist/index.js not found. Please run 'npm run build' first!");
    process.exit(1);
  }

  const mcpServerConfig = {
    command: "node",
    args: [serverScript],
    env: {
      KB_DB_PATH: dbPath,
    },
  };

  const agents: Record<string, TargetAgent> = {
    claude: {
      id: "claude",
      name: "Claude Desktop",
      configPath: path.join(
        homeDir,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      ),
      rulesSourcePath: path.join(rootDir, "agent-plugins", "claude", "CLAUDE_INSTRUCTIONS.md"),
    },
    cursor: {
      id: "cursor",
      name: "Cursor IDE",
      configPath: path.join(homeDir, ".cursor", "mcp.json"),
      rulesSourcePath: path.join(rootDir, "agent-plugins", "cursor", ".cursorrules"),
      rulesDestPath: path.join(rootDir, ".cursorrules"),
    },
    cline: {
      id: "cline",
      name: "VS Code (Cline / Roo Code)",
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
      rulesSourcePath: path.join(rootDir, "agent-plugins", "vscode-cline", ".clinerules"),
      rulesDestPath: path.join(rootDir, ".clinerules"),
    },
    windsurf: {
      id: "windsurf",
      name: "Windsurf Cascade",
      configPath: path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
      rulesSourcePath: path.join(rootDir, "agent-plugins", "windsurf", ".windsurfrules"),
      rulesDestPath: path.join(rootDir, ".windsurfrules"),
    },
    antigravity: {
      id: "antigravity",
      name: "Antigravity",
      configPath: path.join(homeDir, ".gemini", "config", "plugins", "knowledge-base", "mcp_config.json"),
    },
  };

  const targetsToInstall =
    targetArg === "all" ? Object.values(agents) : agents[targetArg] ? [agents[targetArg]] : [];

  if (targetsToInstall.length === 0) {
    console.error(`❌ Unknown agent target: '${targetArg}'`);
    console.log("Available options: claude | cursor | cline | windsurf | antigravity | all");
    process.exit(1);
  }

  console.log("==========================================================");
  console.log(`   📦 INSTALLING KNOWLEDGE BASE PLUGIN FOR: ${targetArg.toUpperCase()} `);
  console.log("==========================================================\n");

  let successCount = 0;

  for (const agent of targetsToInstall) {
    try {
      const configDir = path.dirname(agent.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // 1. Read existing config
      let existingConfig: any = {};
      if (fs.existsSync(agent.configPath)) {
        try {
          const raw = fs.readFileSync(agent.configPath, "utf-8");
          existingConfig = JSON.parse(raw);
        } catch {
          existingConfig = {};
        }
      }

      if (!existingConfig.mcpServers) {
        existingConfig.mcpServers = {};
      }

      // 2. Merge knowledge-base MCP server
      existingConfig.mcpServers["knowledge-base"] = mcpServerConfig;

      // 3. Write config back safely
      fs.writeFileSync(agent.configPath, JSON.stringify(existingConfig, null, 2), "utf-8");
      console.log(`✅ [${agent.name}] MCP Configuration applied successfully!`);
      console.log(`   Config File: ${agent.configPath}`);

      // 4. Copy rules to workspace if applicable
      if (agent.rulesSourcePath && agent.rulesDestPath && fs.existsSync(agent.rulesSourcePath)) {
        fs.copyFileSync(agent.rulesSourcePath, agent.rulesDestPath);
        console.log(`   Agent Rules: Copied to ${agent.rulesDestPath}`);
      }

      console.log("");
      successCount++;
    } catch (err: any) {
      console.error(`⚠️  [${agent.name}] Failed to configure: ${err.message}\n`);
    }
  }

  console.log("==========================================================");
  console.log(`🎉 Setup complete for ${successCount} agent(s)!`);
  console.log("👉 Restart your target AI Agent to activate the plugin.");
  console.log("==========================================================\n");
}

const target = process.argv[2] || "all";
installPluginFor(target);
