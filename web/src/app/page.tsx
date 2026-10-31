"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Network,
  Share2,
  UploadCloud,
  AlertTriangle,
  FileCheck,
  Gauge,
  FolderGit2,
  FolderPlus,
  ZoomIn,
  RefreshCw,
  ShieldCheck,
  Filter,
} from "lucide-react";
import { apiUrl } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GraphCanvas, GraphNode, GraphEdge } from "@/components/GraphCanvas";
import { NodeInspector } from "@/components/NodeInspector";
import { IngestZone } from "@/components/IngestZone";
import { GapKanban } from "@/components/GapKanban";
import { ProvenanceInspector } from "@/components/ProvenanceInspector";
import { TelemetryDashboard } from "@/components/TelemetryDashboard";
import { ArchitectureHealth } from "@/components/ArchitectureHealth";
import { IndexingStatus } from "@/components/IndexingStatus";
import { ProjectManager } from "@/components/ProjectManager";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";

export default function KnowledgeStudioPage() {
  const [activeTab, setActiveTab] = useState<"graph" | "health" | "ingest" | "gaps" | "provenance" | "telemetry">("graph");
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [lod, setLod] = useState<number>(0);
  const [selectedDir, setSelectedDir] = useState<string>("all");
  const [graphStats, setGraphStats] = useState<{ totalNodes: number; renderedNodes: number }>({
    totalNodes: 0,
    renderedNodes: 0,
  });
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [provenanceTargetNodeId, setProvenanceTargetNodeId] = useState<string | null>(null);
  const [pendingGapCount, setPendingGapCount] = useState<number>(0);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState<boolean>(false);
  const [isManageOpen, setIsManageOpen] = useState<boolean>(false);

  // Load Projects List
  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/projects"));
      const data = await res.json();
      const list: string[] = data.projects || [];
      setProjects(list);
      // Always keep a valid project selected (no "all" view)
      setSelectedProject((cur) => (list.includes(cur) ? cur : list[0] || ""));
    } catch (err) {
      console.error("Failed to load projects", err);
    }
  }, []);

  const handleProjectCreated = async (newProjectId: string) => {
    await fetchProjects();
    setSelectedProject(newProjectId);
    setActiveTab("graph");
  };

  // Load Graph Topology
  const fetchGraph = useCallback(async () => {
    if (!selectedProject) {
      setNodes([]);
      setEdges([]);
      setGraphStats({ totalNodes: 0, renderedNodes: 0 });
      return;
    }
    try {
      const url = apiUrl(`/api/graph?project_id=${encodeURIComponent(selectedProject)}&lod=${lod}`);
      const res = await fetch(url);
      const data = await res.json();
      setNodes(data.nodes || []);
      setEdges(data.edges || []);
      setGraphStats({
        totalNodes: data.totalNodes || 0,
        renderedNodes: data.renderedNodes || (data.nodes ? data.nodes.length : 0),
      });
    } catch (err) {
      console.error("Failed to load graph", err);
    }
  }, [selectedProject, lod]);

  // Load Gap Count for Badging
  const fetchGapCount = useCallback(async () => {
    if (!selectedProject) {
      setPendingGapCount(0);
      return;
    }
    try {
      const url = apiUrl(`/api/gaps?project_id=${encodeURIComponent(selectedProject)}&status=open`);
      const res = await fetch(url);
      const data = await res.json();
      setPendingGapCount(data.gaps?.length || 0);
    } catch (err) {
      console.error("Failed to fetch gap count", err);
    }
  }, [selectedProject]);

  const refreshAll = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.all([fetchProjects(), fetchGraph(), fetchGapCount()]);
    setIsRefreshing(false);
  }, [fetchProjects, fetchGraph, fetchGapCount]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const handleSelectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
  };

  const handleCloseInspector = () => {
    setSelectedNodeId(null);
  };

  const handleViewProvenance = (nodeId: string) => {
    setProvenanceTargetNodeId(nodeId);
    setActiveTab("provenance");
  };

  const availableDirs = React.useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) {
      const fp = n.properties?.file_path as string | undefined;
      if (fp) {
        const parts = fp.replace(/\\/g, "/").split("/").filter(Boolean);
        if (parts.length >= 2) {
          set.add(parts.slice(-3, -1).join("/"));
        }
      }
    }
    return Array.from(set).slice(0, 15).sort();
  }, [nodes]);

  const displayedNodes = React.useMemo(() => {
    if (selectedDir === "all") return nodes;
    return nodes.filter((n) => {
      const fp = n.properties?.file_path as string | undefined;
      return fp && fp.replace(/\\/g, "/").includes(selectedDir);
    });
  }, [nodes, selectedDir]);

  const displayedEdges = React.useMemo(() => {
    if (selectedDir === "all") return edges;
    const nodeIds = new Set(displayedNodes.map((n) => n.id));
    return edges.filter((e) => nodeIds.has(e.source_id) && nodeIds.has(e.target_id));
  }, [edges, displayedNodes, selectedDir]);

  return (
    <div className="flex flex-col h-dvh w-full overflow-hidden bg-slate-950 text-slate-100">
      {/* ══════════════════════════════════════════════════════════ */}
      {/* TOP NAVIGATION BAR                                         */}
      {/* ══════════════════════════════════════════════════════════ */}
      <header className="min-h-16 border-b border-slate-800 bg-slate-900/90 backdrop-blur px-3 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 shrink-0 z-30">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Network className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-sm leading-tight flex items-center gap-2 text-white">
              Neural Knowledge Studio
              <Badge variant="success" className="font-mono text-[10px]">
                MCP Live
              </Badge>
            </h1>
            <p className="hidden sm:block text-[11px] text-slate-400">Next.js & shadcn/ui Local Semantic Graph Studio</p>
          </div>
        </div>

        {/* Center Navigation Tabs */}
        <nav className="order-last lg:order-none w-full lg:w-auto flex items-center overflow-x-auto bg-slate-800/80 p-1 rounded-xl border border-slate-700/60 shadow-inner [&>button]:shrink-0 [&>button]:whitespace-nowrap">
          <button
            onClick={() => setActiveTab("graph")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === "graph"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <Share2 className="w-3.5 h-3.5" /> Sơ Đồ Neuron
          </button>

          <button
            onClick={() => setActiveTab("health")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === "health"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" /> Sức Khỏe Kiến Trúc
          </button>

          <button
            onClick={() => setActiveTab("ingest")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === "ingest"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <UploadCloud className="w-3.5 h-3.5" /> Nạp Dữ Liệu
          </button>

          <button
            onClick={() => setActiveTab("gaps")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === "gaps"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" /> Lỗ Hổng Tri Thức
            {pendingGapCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold">
                {pendingGapCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab("provenance")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === "provenance"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <FileCheck className="w-3.5 h-3.5" /> Dẫn Chứng Nguyên Văn
          </button>

          <button
            onClick={() => setActiveTab("telemetry")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === "telemetry"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <Gauge className="w-3.5 h-3.5" /> Hiệu Năng & ROI
          </button>
        </nav>

        {/* Right Project & Filter Controls */}
        <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
          {/* Project Selector */}
          <div className="flex items-center gap-1.5 text-xs text-slate-300 bg-slate-800/80 px-2 sm:px-3 py-1.5 rounded-lg border border-slate-700/60 min-w-0">
            <FolderGit2 className="w-3.5 h-3.5 text-indigo-400" />
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="bg-transparent text-white font-medium focus:outline-none cursor-pointer text-xs max-w-[110px] sm:max-w-none truncate"
            >
              {projects.map((p) => (
                <option key={p} value={p} className="bg-slate-800">
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* Create Project Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsCreateProjectOpen(true)}
            className="h-8 gap-1.5 text-xs bg-slate-800/80 border-slate-700/60 hover:bg-slate-700 text-slate-200 hover:text-white"
            title="Tạo không gian dự án mới"
          >
            <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
            <span className="hidden sm:inline">Tạo Dự Án</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsManageOpen(true)}
            className="h-8 text-xs bg-slate-800/80 border-slate-700/60 hover:bg-slate-700 text-slate-200 hover:text-white"
            title="Quản lý dự án"
          >
            Quản lý
          </Button>

          {/* Branch / Package Filter */}
          {availableDirs.length > 0 && activeTab === "graph" && (
            <div className="hidden xl:flex items-center gap-1.5 text-xs text-slate-300 bg-slate-800/80 px-2.5 py-1.5 rounded-lg border border-slate-700/60">
              <Filter className="w-3.5 h-3.5 text-cyan-400" />
              <select
                value={selectedDir}
                onChange={(e) => setSelectedDir(e.target.value)}
                className="bg-transparent text-white font-medium focus:outline-none cursor-pointer text-xs max-w-[130px] truncate"
              >
                <option value="all" className="bg-slate-800">
                  Tất cả nhánh
                </option>
                {availableDirs.map((dir) => (
                  <option key={dir} value={dir} className="bg-slate-800">
                    {dir}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* LOD Selector */}
          <div className="flex items-center gap-1.5 text-xs text-slate-300 bg-slate-800/80 px-2.5 py-1.5 rounded-lg border border-slate-700/60">
            <ZoomIn className="w-3.5 h-3.5 text-purple-400" />
            <select
              value={lod}
              onChange={(e) => setLod(Number(e.target.value))}
              className="bg-transparent text-white font-medium focus:outline-none cursor-pointer text-xs"
            >
              <option value={0} className="bg-slate-800">
                LOD 0: Vĩ mô (Top 25)
              </option>
              <option value={1} className="bg-slate-800">
                LOD 1: Trung mô (Top 80)
              </option>
              <option value={2} className="bg-slate-800">
                LOD 2: Chi tiết (Top 250)
              </option>
            </select>
          </div>

          {/* Node count stats badge */}
          {graphStats.totalNodes > 0 && (
            <span
              className="hidden lg:inline-flex items-center px-2 py-1 rounded text-[11px] bg-slate-800/60 text-slate-400 border border-slate-700/50 font-mono"
              title="Số nút đang hiển thị / Tổng số nút trong dự án"
            >
              {graphStats.renderedNodes}/{graphStats.totalNodes} nút
            </span>
          )}

          {/* Refresh Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={refreshAll}
            disabled={isRefreshing}
            className="h-8 w-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60"
            title="Làm mới toàn bộ dữ liệu"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </header>

      {/* ══════════════════════════════════════════════════════════ */}
      {/* MAIN VIEW CONTENT CONTAINER                                */}
      {/* ══════════════════════════════════════════════════════════ */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* TAB 0: ARCHITECTURE HEALTH & DIAGNOSTICS */}
        {activeTab === "health" && (
          <div className="flex-1 h-full overflow-hidden">
            <ArchitectureHealth
              projectId={selectedProject}
              onSelectNode={(nodeId) => {
                setSelectedNodeId(nodeId);
                setActiveTab("graph");
              }}
            />
          </div>
        )}

        {/* TAB 1: GRAPH CANVAS */}
        {activeTab === "graph" && (
          <div className="flex-1 flex h-full relative">
            <div className="flex-1 h-full">
              <GraphCanvas
                nodes={displayedNodes}
                edges={displayedEdges}
                onSelectNode={handleSelectNode}
                selectedNodeId={selectedNodeId}
                projectId={selectedProject}
              />
            </div>
            {selectedNodeId && (
              <NodeInspector
                nodeId={selectedNodeId}
                onClose={handleCloseInspector}
                onViewProvenance={handleViewProvenance}
              />
            )}
          </div>
        )}

        {activeTab !== "ingest" && (
          <div className="px-4 pt-3 empty:hidden">
            <IndexingStatus projectId={selectedProject} onJobFinished={refreshAll} />
          </div>
        )}

        {/* TAB 2: INGESTION HUB */}
        {activeTab === "ingest" && (
          <>
            <div className="px-4 pt-3 max-w-4xl w-full mx-auto">
              <IndexingStatus projectId={selectedProject} history onJobFinished={refreshAll} />
            </div>
            <IngestZone projectId={selectedProject} onIngestSuccess={refreshAll} />
          </>
        )}

        {/* TAB 3: GAP KANBAN */}
        {activeTab === "gaps" && (
          <GapKanban projectId={selectedProject} />
        )}

        {/* TAB 4: PROVENANCE SPLIT INSPECTOR */}
        {activeTab === "provenance" && (
          <ProvenanceInspector key={selectedProject} projectId={selectedProject} initialNodeId={provenanceTargetNodeId} />
        )}

        {/* TAB 5: TELEMETRY & ROI */}
        {activeTab === "telemetry" && (
          <TelemetryDashboard />
        )}
      </main>

      <ProjectManager isOpen={isManageOpen} onClose={() => setIsManageOpen(false)} onChanged={refreshAll} />

      {/* Modal: Create Project Dialog */}
      <CreateProjectDialog
        isOpen={isCreateProjectOpen}
        onClose={() => setIsCreateProjectOpen(false)}
        onProjectCreated={handleProjectCreated}
      />
    </div>
  );
}
