import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { initDatabase, DatabaseInstance } from "../database.js";
import { graphMemory } from "../engine/graph_memory.js";
import { telemetry } from "../engine/telemetry.js";
import { jobs } from "../engine/jobs.js";
import { initUsage, usageSummary } from "../engine/usage.js";
import { activeTools } from "../tools/index.js";
import { persistExtraction } from "../engine/persist.js";
import { computeCentrality, filterHubNodes } from "../engine/pagerank.js";
import { knowledgeExtractor } from "../engine/parsers/extractor.js";
import { LevelOfDetail } from "../types.js";

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || "4242", 10);
// Next.js static export (`npm run build`); in dev the UI runs on its own port
const WEB_DIR = path.join(process.cwd(), "web", "out");

export function startHttpServer(db?: DatabaseInstance) {
  const database = db || initDatabase();
  graphMemory.hydrate(database);
  telemetry.attach(database);
  initUsage(database);
  const schemaTokens = Math.ceil(JSON.stringify(activeTools()).length / 4);

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;
    if (pathname.startsWith("/api/")) graphMemory.syncIfStale(database);

    // ══════════════════════════════════════════════════════════
    // REST API ENDPOINTS
    // ══════════════════════════════════════════════════════════

    // 1. Health check
    if (pathname === "/api/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
      return;
    }

    // 2. List Projects
    if (pathname === "/api/projects" && req.method === "GET") {
      const rows = database
        .prepare(`
          SELECT id, name, description, domain, created_at,
                 (SELECT COUNT(*) FROM graph_nodes n WHERE n.project_id = projects.id) AS node_count
          FROM projects
          UNION
          SELECT DISTINCT project_id AS id, project_id AS name, 'Dự án đã nạp' AS description, 'general' AS domain, CURRENT_TIMESTAMP AS created_at,
                 COUNT(*) AS node_count
          FROM graph_nodes
          WHERE project_id NOT IN (SELECT id FROM projects)
          GROUP BY project_id
          ORDER BY name ASC
        `)
        .all() as any[];
      const projects = rows.map((r) => r.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects, projectDetails: rows }));
      return;
    }

    // 2a. Delete Project (nodes cascade to edges and node_sources via FKs)
    if (pathname === "/api/projects" && req.method === "DELETE") {
      const id = parsedUrl.searchParams.get("id");
      const send = (code: number, body: object) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (!id) return send(400, { error: "Missing id" });
      if (jobs.hasRunning(database, id)) return send(409, { error: "Dự án đang được lập chỉ mục" });
      database.exec("BEGIN");
      try {
        for (const t of ["graph_nodes", "raw_sources", "knowledge_gaps", "ingest_jobs"]) {
          database.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
        }
        database.prepare(`DELETE FROM project_links WHERE project_id = ? OR linked_id = ?`).run(id, id);
        database.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
        database.exec("COMMIT");
      } catch (err: any) {
        database.exec("ROLLBACK");
        return send(500, { error: err.message });
      }
      graphMemory.hydrate(database);
      return send(200, { success: true });
    }

    // 2b. Create Project
    if (pathname === "/api/projects" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const { project_id, name, description, domain } = data;

          if (!project_id || !name) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required fields: project_id, name" }));
            return;
          }

          const cleanId = project_id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");

          const insertProject = database.prepare(`
            INSERT INTO projects (id, name, description, domain)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              description = excluded.description,
              domain = excluded.domain,
              updated_at = CURRENT_TIMESTAMP
          `);
          insertProject.run(cleanId, name.trim(), description?.trim() || null, domain?.trim() || "general");

          // Anchor root hub
          const rootNodeId = `project:${cleanId}`;
          const summary = description?.trim() || `Không gian dự án: ${name.trim()}`;
          const insertNode = database.prepare(`
            INSERT INTO graph_nodes (id, project_id, label, node_type, summary, domain, properties, is_hub)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(id) DO UPDATE SET
              label = excluded.label,
              summary = excluded.summary,
              domain = excluded.domain,
              updated_at = CURRENT_TIMESTAMP
          `);
          insertNode.run(
            rootNodeId,
            cleanId,
            name.trim(),
            "service",
            summary,
            domain?.trim() || "general",
            JSON.stringify({ is_project_root: true })
          );

          graphMemory.addNodeMemory({
            id: rootNodeId,
            project_id: cleanId,
            label: name.trim(),
            node_type: "service",
            summary,
            domain: domain?.trim() || "general",
            properties: { is_project_root: true },
            is_hub: true,
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              project: {
                id: cleanId,
                name: name.trim(),
                description: description?.trim(),
                domain: domain?.trim() || "general",
              },
            })
          );
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 3. Get Graph Topology
    if (pathname === "/api/graph" && req.method === "GET") {
      const projectId = parsedUrl.searchParams.get("project_id");
      const lodParam = parseInt(parsedUrl.searchParams.get("lod") || "0", 10);
      const domainFilter = parsedUrl.searchParams.get("domain");

      let nodes = projectId
        ? graphMemory.getProjectNodes(projectId)
        : graphMemory.getAllNodes();
      let edges = projectId
        ? graphMemory.getProjectEdges(projectId)
        : graphMemory.getAllEdges();

      if (domainFilter && domainFilter !== "all") {
        nodes = nodes.filter((n) => n.domain === domainFilter);
        const nodeIds = new Set(nodes.map((n) => n.id));
        edges = edges.filter((e) => nodeIds.has(e.source_id) && nodeIds.has(e.target_id));
      }

      const totalNodesBeforeLOD = nodes.length;

      // Apply Semantic Zoom (LOD)
      if (lodParam === LevelOfDetail.LOD0_MACRO && nodes.length > 15) {
        const filtered = filterHubNodes(nodes, edges, 15);
        nodes = filtered.hubNodes;
        edges = filtered.hubEdges;
      }

      const centrality = computeCentrality(nodes, edges);
      const nodesWithScore = nodes.map((n) => ({
        ...n,
        centralityScore: centrality.get(n.id)?.score || 0,
        inDegree: centrality.get(n.id)?.inDegree || 0,
        outDegree: centrality.get(n.id)?.outDegree || 0,
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          nodes: nodesWithScore,
          edges,
          totalNodes: totalNodesBeforeLOD,
          renderedNodes: nodes.length,
          lod: lodParam,
        })
      );
      return;
    }

    // 4. Get Node Details & Provenance
    if (pathname.startsWith("/api/nodes/") && req.method === "GET") {
      const nodeId = decodeURIComponent(pathname.replace("/api/nodes/", ""));
      const node = graphMemory.getNode(nodeId);

      if (!node) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Node '${nodeId}' not found` }));
        return;
      }

      // Fetch provenance & raw source
      const prov = database
        .prepare(
          `SELECT ns.*, rs.title, rs.file_path, rs.source_type, rs.content
           FROM node_sources ns
           JOIN raw_sources rs ON ns.source_id = rs.id
           WHERE ns.node_id = ? LIMIT 1`
        )
        .get(nodeId) as any;

      // Inbound & Outbound edges
      const sub = graphMemory.getRadialSubgraph(nodeId, 1, 30);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          node,
          provenance: prov || null,
          neighbors: sub.nodes.filter((n) => n.id !== nodeId),
          relations: sub.edges,
        })
      );
      return;
    }

    // 5. Knowledge Gaps List
    if (pathname === "/api/gaps" && req.method === "GET") {
      const projectId = parsedUrl.searchParams.get("project_id");
      const status = parsedUrl.searchParams.get("status") || "all";

      let sql = `SELECT * FROM knowledge_gaps WHERE 1=1`;
      const params: any[] = [];

      if (projectId) {
        sql += ` AND project_id = ?`;
        params.push(projectId);
      }
      if (status !== "all") {
        sql += ` AND status = ?`;
        params.push(status);
      }
      sql += ` ORDER BY id DESC`;

      const gaps = database.prepare(sql).all(...params);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ gaps }));
      return;
    }

    // 6. Resolve Knowledge Gap
    if (pathname.match(/^\/api\/gaps\/(\d+)\/resolve$/) && req.method === "POST") {
      const gapId = parseInt(pathname.split("/")[3], 10);
      database
        .prepare(`UPDATE knowledge_gaps SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(gapId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, gapId }));
      return;
    }

    // 7. System Stats
    if (pathname === "/api/stats" && req.method === "GET") {
      const projectId = parsedUrl.searchParams.get("project_id");
      const allNodes = projectId
        ? graphMemory.getProjectNodes(projectId)
        : graphMemory.getAllNodes();
      const allEdges = projectId
        ? graphMemory.getProjectEdges(projectId)
        : graphMemory.getAllEdges();

      const typeCounts: Record<string, number> = {};
      const domainCounts: Record<string, number> = {};

      for (const n of allNodes) {
        typeCounts[n.node_type] = (typeCounts[n.node_type] || 0) + 1;
        domainCounts[n.domain] = (domainCounts[n.domain] || 0) + 1;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          totalNodes: allNodes.length,
          totalEdges: allEdges.length,
          typeCounts,
          domainCounts,
        })
      );
      return;
    }

    // 8. Telemetry & Metrics
    if (pathname === "/api/metrics" && req.method === "GET") {
      const stats = telemetry.getStats(
        graphMemory.getAllNodes().length,
        graphMemory.getAllEdges().length
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }

    // 8a. MCP usage analytics
    if (pathname === "/api/usage" && req.method === "GET") {
      const days = Math.min(90, Math.max(1, Number(parsedUrl.searchParams.get("days")) || 14));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...usageSummary(database, days, schemaTokens), all_tools: activeTools().map((t) => t.name) }));
      return;
    }

    // 8b. Indexing job status
    if (pathname === "/api/jobs" && req.method === "GET") {
      const list = jobs.list(database, parsedUrl.searchParams.get("project_id") || undefined);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jobs: list }));
      return;
    }

    if (pathname === "/api/jobs/cancel" && req.method === "POST") {
      const ok = jobs.cancel(database, Number(parsedUrl.searchParams.get("id")));
      res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // 9. Ingest File or Raw Text
    if (pathname === "/api/ingest" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        let jobId = 0;
        try {
          const data = JSON.parse(body);
          const { project_id, file_path, content, file_name, domain } = data;

          let targetPath = file_path;
          if (!targetPath && content && file_name) {
            // Write temporary file for parsing
            const tempDir = path.join(process.cwd(), "data", "uploads");
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            targetPath = path.join(tempDir, file_name);
            fs.writeFileSync(targetPath, content, "utf-8");
          }

          if (!targetPath || !fs.existsSync(targetPath)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing valid file_path or content" }));
            return;
          }

          jobId = jobs.start(database, project_id || "default", path.basename(targetPath), 1);
          const result = await knowledgeExtractor.extractFromFile(
            project_id || "default",
            targetPath,
            domain || "auto"
          );

          persistExtraction(database, project_id || "default", targetPath, result);

          const insertGapStmt = database.prepare(`
            INSERT INTO knowledge_gaps (project_id, missing_item, reason, suggested_action, status)
            VALUES (?, ?, ?, ?, 'open')
          `);

          const existingIds = new Set(result.nodes.map((n) => n.id));
          for (const edge of result.edges) {
            if (!graphMemory.getNode(edge.target_id) && !existingIds.has(edge.target_id)) {
              insertGapStmt.run(
                project_id || "default",
                edge.target_id,
                `Neuron '${edge.source_id}' tham chiếu tới thành phần chưa có '${edge.target_id}' qua quan hệ ${edge.relation_type}`,
                `Bổ sung đặc tả hoặc mã nguồn cho '${edge.target_id}'`
              );
            }
          }

          jobs.progress(database, jobId, { processed: 1, skipped: 0, failed: 0 });
          jobs.finish(database, jobId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              nodesCreated: result.nodes.length,
              edgesCreated: result.edges.length,
            })
          );
        } catch (err: any) {
          if (jobId) jobs.finish(database, jobId, err.message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ══════════════════════════════════════════════════════════
    // STATIC FILE SERVING FOR WEB STUDIO UI
    // ══════════════════════════════════════════════════════════
    let filePath = path.join(WEB_DIR, pathname === "/" ? "index.html" : decodeURIComponent(pathname));

    // Block path traversal out of WEB_DIR
    if (!filePath.startsWith(WEB_DIR + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("403 Forbidden");
      return;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      filePath = path.join(WEB_DIR, "index.html");
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".txt": "text/plain; charset=utf-8",
      };

      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  });

  server.listen(PORT, () => {
    console.log(`\n==========================================================`);
    console.log(`   🌐 NEURAL KNOWLEDGE STUDIO (WEB UI) RUNNING            `);
    console.log(`   👉 URL: http://localhost:${PORT}                      `);
    console.log(`==========================================================\n`);
  });

  return server;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("http.ts") || process.argv[1].endsWith("http.js"));

if (isMain) {
  startHttpServer();
}
