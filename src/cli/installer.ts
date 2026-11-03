import fs from "fs";
import path from "path";
import os from "os";

interface TargetAgent {
  id: string;
  name: string;
  configPath: string;
  rootKey?: "mcpServers" | "servers";
  includeTypeStdio?: boolean;
  extraConfigPaths?: string[];
  rulesSourcePath?: string;
  rulesDestPath?: string;
  extraRulesDestPaths?: string[];
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
      rulesSourcePath: path.join(rootDir, "agent-plugins", "antigravity", "rules", "AGENTS.md"),
      rulesDestPath: path.join(homeDir, ".gemini", "config", "plugins", "knowledge-base", "rules", "AGENTS.md"),
    },
    github_copilot: {
      id: "github_copilot",
      name: "GitHub Copilot (VS Code & JetBrains / Android Studio)",
      configPath: path.join(
        homeDir,
        "Library",
        "Application Support",
        "Code",
        "User",
        "mcp.json"
      ),
      rootKey: "servers",
      includeTypeStdio: true,
      extraConfigPaths: [
        path.join(homeDir, ".config", "github-copilot", "intellij", "mcp.json"),
      ],
      rulesSourcePath: path.join(rootDir, "agent-plugins", "github-copilot", "copilot-instructions.md"),
      rulesDestPath: path.join(rootDir, ".github", "copilot-instructions.md"),
      extraRulesDestPaths: [
        path.join(homeDir, ".copilot", "instructions", "knowledge-base.instructions.md"),
        path.join(homeDir, ".config", "github-copilot", "intellij", "global-copilot-instructions.md"),
      ],
    },
  };

  const normalizedArg = targetArg === "copilot" || targetArg === "github-copilot" ? "github_copilot" : targetArg;
  const targetsToInstall =
    normalizedArg === "all"
      ? Object.values(agents)
      : agents[normalizedArg]
      ? [agents[normalizedArg]]
      : [];

  if (targetsToInstall.length === 0) {
    console.error(`❌ Unknown agent target: '${targetArg}'`);
    console.log("Available options: claude | cursor | cline | windsurf | antigravity | github_copilot | all");
    process.exit(1);
  }

  console.log("==========================================================");
  console.log(`   📦 INSTALLING KNOWLEDGE BASE PLUGIN FOR: ${normalizedArg.toUpperCase()} `);
  console.log("==========================================================\n");

  let successCount = 0;

  for (const agent of targetsToInstall) {
    try {
      const rootKey = agent.rootKey || "mcpServers";
      const entryPayload = agent.includeTypeStdio
        ? { type: "stdio", ...mcpServerConfig }
        : mcpServerConfig;

      const allConfigPaths = [agent.configPath, ...(agent.extraConfigPaths || [])];
      for (const cfgPath of allConfigPaths) {
        const configDir = path.dirname(cfgPath);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }

        let existingConfig: any = {};
        if (fs.existsSync(cfgPath)) {
          try {
            const raw = fs.readFileSync(cfgPath, "utf-8").trim();
            if (raw) existingConfig = JSON.parse(raw);
          } catch {
            existingConfig = {};
          }
        }

        if (!existingConfig[rootKey] || typeof existingConfig[rootKey] !== "object") {
          existingConfig[rootKey] = {};
        }

        existingConfig[rootKey]["knowledge-base"] = entryPayload;
        fs.writeFileSync(cfgPath, JSON.stringify(existingConfig, null, 2), "utf-8");
        console.log(`✅ [${agent.name}] MCP Configuration applied!`);
        console.log(`   Config File: ${cfgPath}`);
      }

      // Copy rules to workspace and global instruction paths if applicable
      if (agent.rulesSourcePath && fs.existsSync(agent.rulesSourcePath)) {
        const allRuleDests = [
          ...(agent.rulesDestPath ? [agent.rulesDestPath] : []),
          ...(agent.extraRulesDestPaths || []),
        ];
        for (const dest of allRuleDests) {
          const destDir = path.dirname(dest);
          if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
          }
          fs.copyFileSync(agent.rulesSourcePath, dest);
          console.log(`   Agent Rules: Copied to ${dest}`);
        }
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
