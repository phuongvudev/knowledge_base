"use client";

import React, { useEffect, useRef, useState, useMemo } from "react";
import { Network } from "vis-network";
import { Maximize2, ZoomIn, ZoomOut, Play, Pause, Search, X } from "lucide-react";
import { Button } from "./ui/button";

export interface GraphNode {
  id: string;
  project_id: string;
  label: string;
  node_type: string;
  summary: string;
  domain: string;
  is_hub: boolean;
  centralityScore?: number;
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  relation_type: string;
  description?: string;
  weight?: number;
}

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onSelectNode: (nodeId: string) => void;
  selectedNodeId?: string | null;
}

const TYPE_COLORS: Record<string, { bg: string; border: string }> = {
  service: { bg: "#3b82f6", border: "#60a5fa" },
  policy: { bg: "#a855f7", border: "#c084fc" },
  rule: { bg: "#f59e0b", border: "#fbbf24" },
  person: { bg: "#10b981", border: "#34d399" },
  module: { bg: "#06b6d4", border: "#22d3ee" },
  api_endpoint: { bg: "#ec4899", border: "#f472b6" },
  data_model: { bg: "#8b5cf6", border: "#a78bfa" },
  database: { bg: "#6366f1", border: "#818cf8" },
  env_config: { bg: "#eab308", border: "#fde047" },
  default: { bg: "#64748b", border: "#94a3b8" },
};

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  nodes,
  edges,
  onSelectNode,
  selectedNodeId,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const [isPhysicsActive, setIsPhysicsActive] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  // Initialize or update network when nodes or edges change
  useEffect(() => {
    if (!containerRef.current) return;

    if (nodes.length === 0) {
      if (networkRef.current) {
        networkRef.current.destroy();
        networkRef.current = null;
      }
      return;
    }

    const isLarge = nodes.length > 50;

    const visNodes = nodes.map((n) => {
      const col = TYPE_COLORS[n.node_type] || TYPE_COLORS.default;
      return {
        id: n.id,
        label: n.label,
        title: `[${n.node_type.toUpperCase()}] ${n.summary}`,
        shape:
          n.node_type === "person"
            ? "circle"
            : n.node_type === "data_model" || n.node_type === "database"
            ? "database"
            : "box",
        color: {
          background: col.bg,
          border: col.border,
          highlight: { background: "#ef4444", border: "#f87171" },
          hover: { background: col.bg, border: "#ffffff" },
        },
        font: {
          color: "#ffffff",
          size: n.is_hub ? 13 : 11,
          face: "system-ui, -apple-system, sans-serif",
        },
        margin: 10,
        borderWidth: n.is_hub ? 3 : 1,
        shadow: n.is_hub && !isLarge
          ? { enabled: true, color: "rgba(99, 102, 241, 0.4)", size: 10 }
          : false,
      };
    });

    const visEdges: any[] = edges.map((e) => ({
      from: e.source_id,
      to: e.target_id,
      label: isLarge ? undefined : e.relation_type,
      arrows: "to",
      font: { size: 9, color: "#94a3b8", align: "middle", strokeWidth: 0 },
      color: { color: "#334155", highlight: "#ef4444", hover: "#64748b" },
      smooth: isLarge ? false : { enabled: true, type: "continuous", roundness: 0.2 },
      width: 1.2,
    }));

    const options = {
      physics: {
        solver: isLarge ? "forceAtlas2Based" : "barnesHut",
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.01,
          springLength: 90,
          springConstant: 0.08,
          damping: 0.4,
          avoidOverlap: 0.5,
        },
        barnesHut: {
          gravitationalConstant: -4000,
          centralGravity: 0.3,
          springLength: 130,
          springConstant: 0.04,
          damping: 0.09,
        },
        stabilization: {
          enabled: true,
          iterations: isLarge ? 40 : 100,
          updateInterval: 20,
        },
      },
      interaction: {
        hover: true,
        tooltipDelay: 120,
        selectable: true,
        navigationButtons: false,
        hideEdgesOnDrag: isLarge,
      },
      nodes: {
        scaling: { min: 14, max: 30 },
      },
    };

    const net = new Network(
      containerRef.current,
      { nodes: visNodes as any, edges: visEdges as any },
      options as any
    );
    networkRef.current = net;
    setIsPhysicsActive(true);

    // Auto-freeze physics once stabilized to drop CPU usage to 0%
    net.once("stabilizationIterationsDone", () => {
      net.setOptions({ physics: { enabled: false } });
      setIsPhysicsActive(false);
    });

    net.on("click", (params) => {
      if (params.nodes && params.nodes.length > 0) {
        onSelectNode(params.nodes[0] as string);
      }
    });

    return () => {
      net.destroy();
      networkRef.current = null;
    };
  }, [nodes, edges, onSelectNode]);

  // Synchronize selection without recreating network
  useEffect(() => {
    if (!networkRef.current) return;
    if (selectedNodeId) {
      networkRef.current.selectNodes([selectedNodeId]);
    } else {
      networkRef.current.unselectAll();
    }
  }, [selectedNodeId]);

  const handleFit = () =>
    (networkRef.current as any)?.fit({
      animation: { duration: 500, easingFunction: "easeInOutQuad" },
    });

  const handleZoomIn = () => {
    if (!networkRef.current) return;
    const scale = networkRef.current.getScale();
    (networkRef.current as any).moveTo({
      scale: scale * 1.3,
      animation: { duration: 300, easingFunction: "easeInOutQuad" },
    });
  };

  const handleZoomOut = () => {
    if (!networkRef.current) return;
    const scale = networkRef.current.getScale();
    (networkRef.current as any).moveTo({
      scale: scale * 0.7,
      animation: { duration: 300, easingFunction: "easeInOutQuad" },
    });
  };

  const togglePhysics = () => {
    if (!networkRef.current) return;
    const next = !isPhysicsActive;
    networkRef.current.setOptions({ physics: { enabled: next } });
    setIsPhysicsActive(next);
  };

  const focusNode = (nodeId: string) => {
    if (!networkRef.current) return;
    networkRef.current.selectNodes([nodeId]);
    (networkRef.current as any).focus(nodeId, {
      scale: 1.2,
      animation: { duration: 500, easingFunction: "easeInOutQuad" },
    });
    onSelectNode(nodeId);
    setIsSearching(false);
    setSearchQuery("");
  };

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return nodes
      .filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .slice(0, 8);
  }, [nodes, searchQuery]);

  return (
    <div className="relative w-full h-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-[#020617] overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />

      {/* Floating Canvas Controls */}
      <div className="absolute bottom-3 right-3 sm:bottom-5 sm:right-5 flex items-center gap-1.5 bg-slate-900/90 backdrop-blur border border-slate-800 p-1 rounded-xl shadow-2xl z-10">
        <Button variant="ghost" size="icon" onClick={handleZoomIn} title="Phóng to">
          <ZoomIn className="w-4 h-4 text-slate-300" />
        </Button>
        <Button variant="ghost" size="icon" onClick={handleZoomOut} title="Thu nhỏ">
          <ZoomOut className="w-4 h-4 text-slate-300" />
        </Button>
        <Button variant="ghost" size="icon" onClick={handleFit} title="Vừa màn hình">
          <Maximize2 className="w-4 h-4 text-slate-300" />
        </Button>
        <div className="w-[1px] h-4 bg-slate-800 mx-0.5" />
        <Button
          variant="ghost"
          size="icon"
          onClick={togglePhysics}
          title={isPhysicsActive ? "Tạm dừng vật lý" : "Tiếp tục vật lý"}
        >
          {isPhysicsActive ? (
            <Pause className="w-4 h-4 text-emerald-400" />
          ) : (
            <Play className="w-4 h-4 text-slate-400" />
          )}
        </Button>
      </div>

      {/* Top Floating Search & Quick Focus */}
      <div className="absolute top-3 right-3 sm:top-5 sm:right-5 z-20 flex flex-col items-end">
        {!isSearching ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsSearching(true)}
            className="h-8 gap-1.5 text-xs bg-slate-900/90 backdrop-blur border-slate-800 hover:bg-slate-800 text-slate-300 hover:text-white shadow-lg"
          >
            <Search className="w-3.5 h-3.5 text-indigo-400" />
            <span>Tìm nút</span>
          </Button>
        ) : (
          <div className="flex flex-col bg-slate-900/95 backdrop-blur border border-slate-800 rounded-xl p-1.5 shadow-2xl w-64 sm:w-72">
            <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-950/70 rounded-lg border border-slate-800/80">
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm nút theo tên / id..."
                autoFocus
                className="bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none w-full"
              />
              <button
                onClick={() => {
                  setIsSearching(false);
                  setSearchQuery("");
                }}
                className="text-slate-400 hover:text-white p-0.5"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="mt-1 max-h-48 overflow-y-auto flex flex-col gap-0.5 divide-y divide-slate-800/50">
                {searchResults.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => focusNode(n.id)}
                    className="text-left px-2.5 py-1.5 text-xs rounded hover:bg-indigo-600/20 text-slate-200 hover:text-white transition flex flex-col"
                  >
                    <span className="font-medium truncate">{n.label}</span>
                    <span className="text-[10px] text-slate-400 truncate">{n.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating Legend */}
      <div className="absolute top-2 left-2 sm:top-4 sm:left-4 bg-slate-900/80 backdrop-blur border border-slate-800 rounded-xl p-2.5 shadow-xl pointer-events-none hidden sm:flex flex-wrap gap-2 max-w-[calc(100%-1rem)] sm:max-w-sm z-10">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span> Service / App
        </span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span> Policy / Quy định
        </span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span> Rule / Quy chuẩn
        </span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Person / Vai trò
        </span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-500"></span> Module / Code
        </span>
      </div>
    </div>
  );
};
