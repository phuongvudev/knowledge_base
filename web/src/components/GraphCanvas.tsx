"use client";

import React, { useEffect, useRef, useState } from "react";
import { Network } from "vis-network";
import { Maximize2, ZoomIn, ZoomOut, Play, Pause } from "lucide-react";
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

  useEffect(() => {
    if (!containerRef.current) return;

    const visNodes = nodes.map((n) => {
      const col = TYPE_COLORS[n.node_type] || TYPE_COLORS.default;
      const isSelected = selectedNodeId === n.id;
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
          background: isSelected ? "#ef4444" : col.bg,
          border: isSelected ? "#fca5a5" : col.border,
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
        shadow: n.is_hub
          ? { enabled: true, color: "rgba(99, 102, 241, 0.4)", size: 10 }
          : false,
      };
    });

    const visEdges: any[] = edges.map((e) => ({
      from: e.source_id,
      to: e.target_id,
      label: e.relation_type,
      arrows: "to",
      font: { size: 9, color: "#94a3b8", align: "middle", strokeWidth: 0 },
      color: { color: "#334155", highlight: "#ef4444", hover: "#64748b" },
      smooth: { enabled: true, type: "continuous", roundness: 0.2 },
      width: 1.2,
    }));

    const options = {
      physics: {
        solver: "barnesHut",
        barnesHut: {
          gravitationalConstant: -4000,
          centralGravity: 0.3,
          springLength: 130,
          springConstant: 0.04,
          damping: 0.09,
        },
        stabilization: { iterations: 100 },
      },
      interaction: {
        hover: true,
        tooltipDelay: 120,
        selectable: true,
        navigationButtons: false,
      },
      nodes: {
        scaling: { min: 14, max: 30 },
      },
    };

    const net = new Network(containerRef.current, { nodes: visNodes as any, edges: visEdges as any }, options as any);
    networkRef.current = net;

    net.on("click", (params) => {
      if (params.nodes && params.nodes.length > 0) {
        onSelectNode(params.nodes[0] as string);
      }
    });

    return () => {
      net.destroy();
      networkRef.current = null;
    };
  }, [nodes, edges, selectedNodeId, onSelectNode]);

  const handleFit = () => (networkRef.current as any)?.fit({ animation: { duration: 500, easingFunction: "easeInOutQuad" } });
  const handleZoomIn = () => {
    if (!networkRef.current) return;
    const scale = networkRef.current.getScale();
    (networkRef.current as any).moveTo({ scale: scale * 1.3, animation: { duration: 300, easingFunction: "easeInOutQuad" } });
  };
  const handleZoomOut = () => {
    if (!networkRef.current) return;
    const scale = networkRef.current.getScale();
    (networkRef.current as any).moveTo({ scale: scale * 0.7, animation: { duration: 300, easingFunction: "easeInOutQuad" } });
  };
  const togglePhysics = () => {
    if (!networkRef.current) return;
    const next = !isPhysicsActive;
    networkRef.current.setOptions({ physics: { enabled: next } });
    setIsPhysicsActive(next);
  };

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
