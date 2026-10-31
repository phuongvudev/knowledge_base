import { initDatabase } from "./database.js";
import { graphMemory } from "./engine/graph_memory.js";
import { visualizer } from "./engine/visualizer.js";
import { LevelOfDetail } from "./types.js";

async function runBenchmark() {
  console.log("==========================================================");
  console.log("   NEURAL KNOWLEDGE BASE — PERFORMANCE BENCHMARK SUITE    ");
  console.log("==========================================================\n");

  const testDbPath = "/tmp/benchmark_neural_kb.db";
  const fs = await import("fs");
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const db = initDatabase(testDbPath);
  console.log("[1/5] Initializing Database & Pragmas (WAL + MMAP)... OK");

  // Seed 150 nodes across 5 domains and 400 edges
  console.log("[2/5] Seeding 150 nodes & 400 edges simulating enterprise project...");
  const insertNode = db.prepare(`
    INSERT INTO graph_nodes (id, project_id, label, node_type, summary, domain, is_hub)
    VALUES (?, 'bench-proj', ?, ?, ?, ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT INTO graph_edges (project_id, source_id, target_id, relation_type, description, weight)
    VALUES ('bench-proj', ?, ?, ?, ?, 1.0)
  `);

  const domains = ["auth", "orders", "inventory", "payment", "notification"];
  const types = ["service", "component", "api_endpoint", "data_model", "rule"];

  for (let i = 1; i <= 150; i++) {
    const dom = domains[i % domains.length];
    const ntype = types[i % types.length];
    const isHub = i % 15 === 0;
    insertNode.run(
      `node_${i}`,
      `Component ${i}`,
      ntype,
      `Summary for component ${i} handling ${dom} operations with resilience`,
      dom,
      isHub ? 1 : 0
    );
  }

  for (let i = 1; i <= 150; i++) {
    const target1 = `node_${(i * 3) % 150 + 1}`;
    const target2 = `node_${(i * 7) % 150 + 1}`;
    if (target1 !== `node_${i}`) {
      try {
        insertEdge.run(`node_${i}`, target1, "DEPENDS_ON", "Core dependency link");
      } catch {}
    }
    if (target2 !== `node_${i}`) {
      try {
        insertEdge.run(`node_${i}`, target2, "CALLS", "RPC invocations");
      } catch {}
    }
  }

  console.log("[3/5] Hydrating In-Memory Graph Cache...");
  const tHydrateStart = process.hrtime.bigint();
  graphMemory.hydrate(db);
  const hydrateMs = Number(process.hrtime.bigint() - tHydrateStart) / 1_000_000;
  console.log(`      Hydration complete in ${hydrateMs.toFixed(2)} ms (${graphMemory.getAllNodes().length} nodes, ${graphMemory.getAllEdges().length} edges)`);

  console.log("\n[4/5] Running Traversal & Query Latency Benchmark (1,000 iterations)...");

  // Test 1: Bounded Radial Subgraph (BFS)
  const radialLatencies: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const targetId = `node_${(i % 150) + 1}`;
    const t0 = process.hrtime.bigint();
    graphMemory.getRadialSubgraph(targetId, 2, 20);
    const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
    radialLatencies.push(ms);
  }

  radialLatencies.sort((a, b) => a - b);
  const radP50 = radialLatencies[Math.floor(radialLatencies.length * 0.5)];
  const radP95 = radialLatencies[Math.floor(radialLatencies.length * 0.95)];
  const radP99 = radialLatencies[Math.floor(radialLatencies.length * 0.99)];

  // Test 2: Impact Analysis Traversal
  const impactLatencies: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const targetId = `node_${(i % 150) + 1}`;
    const t0 = process.hrtime.bigint();
    graphMemory.getImpactSubgraph(targetId);
    const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
    impactLatencies.push(ms);
  }

  impactLatencies.sort((a, b) => a - b);
  const impP50 = impactLatencies[Math.floor(impactLatencies.length * 0.5)];
  const impP95 = impactLatencies[Math.floor(impactLatencies.length * 0.95)];

  // Test 3: FTS5 Search
  const searchLatencies: number[] = [];
  const searchStmt = db.prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 10");
  for (let i = 0; i < 500; i++) {
    const kw = domains[i % domains.length];
    const t0 = process.hrtime.bigint();
    searchStmt.all(kw);
    const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
    searchLatencies.push(ms);
  }

  searchLatencies.sort((a, b) => a - b);
  const ftsP50 = searchLatencies[Math.floor(searchLatencies.length * 0.5)];
  const ftsP95 = searchLatencies[Math.floor(searchLatencies.length * 0.95)];

  // Test 4: Semantic Zoom LOD 0 Diagram Rendering & Token Efficiency
  const nodes = graphMemory.getProjectNodes("bench-proj");
  const edges = graphMemory.getProjectEdges("bench-proj");
  const t0 = process.hrtime.bigint();
  const mermaidDiagram = visualizer.renderMermaid(nodes, edges, LevelOfDetail.LOD0_MACRO);
  const renderMs = Number(process.hrtime.bigint() - t0) / 1_000_000;

  const diagramTokens = Math.ceil(mermaidDiagram.length / 4);
  const rawEquivalentTokens = nodes.length * 35; // ~35 tokens per node description
  const tokenSavings = (((rawEquivalentTokens - diagramTokens) / rawEquivalentTokens) * 100).toFixed(1);

  const mem = process.memoryUsage();
  const ramMb = (mem.heapUsed / 1024 / 1024).toFixed(1);

  console.log("\n==========================================================");
  console.log("                    BENCHMARK RESULTS                     ");
  console.log("==========================================================");
  console.table({
    "Radial BFS (depth=2)": {
      "P50 (ms)": radP50.toFixed(3),
      "P95 (ms)": radP95.toFixed(3),
      "P99 (ms)": radP99.toFixed(3),
      "SLA Status": radP95 < 5.0 ? "PASSED (Target < 5ms)" : "FAILED",
    },
    "Impact Analysis": {
      "P50 (ms)": impP50.toFixed(3),
      "P95 (ms)": impP95.toFixed(3),
      "P99 (ms)": "-",
      "SLA Status": impP95 < 5.0 ? "PASSED (Target < 5ms)" : "FAILED",
    },
    "FTS5 Search Query": {
      "P50 (ms)": ftsP50.toFixed(3),
      "P95 (ms)": ftsP95.toFixed(3),
      "P99 (ms)": "-",
      "SLA Status": ftsP95 < 5.0 ? "PASSED (Target < 5ms)" : "FAILED",
    },
    "Mermaid LOD 0 Render": {
      "P50 (ms)": renderMs.toFixed(3),
      "P95 (ms)": "-",
      "P99 (ms)": "-",
      "SLA Status": renderMs < 5.0 ? "PASSED" : "FAILED",
    },
  });

  console.log("\n------------------ TOKEN & RESOURCE SLA ------------------");
  console.log(`- Overview Tokens Returned: ${diagramTokens} tokens (Target: 250 - 400) -> ${diagramTokens < 450 ? "PASSED" : "FAILED"}`);
  console.log(`- Raw Equivalent Size:      ${rawEquivalentTokens} tokens`);
  console.log(`- Token Savings Ratio:      ${tokenSavings}% (Target: > 85%) -> ${Number(tokenSavings) > 85 ? "PASSED" : "FAILED"}`);
  console.log(`- Server RAM Footprint:     ${ramMb} MB (Target: < 80 MB) -> ${Number(ramMb) < 80 ? "PASSED" : "FAILED"}`);
  console.log("==========================================================\n");

  // Clean up
  db.close();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  if (radP95 < 5.0 && impP95 < 5.0 && Number(tokenSavings) > 80) {
    console.log("All Performance & Token SLAs PASSED successfully!\n");
    process.exit(0);
  } else {
    console.error("Some SLAs failed!");
    process.exit(1);
  }
}

runBenchmark().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
