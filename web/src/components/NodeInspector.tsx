"use client";

import React, { useEffect, useState } from "react";
import { X, ExternalLink, ArrowRight, ArrowLeft, Network, ShieldCheck, FileSearch } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { apiUrl } from "@/lib/api";

interface NodeDetail {
  node: {
    id: string;
    project_id: string;
    label: string;
    node_type: string;
    summary: string;
    domain: string;
    properties?: any;
    is_hub?: boolean;
  };
  provenance: {
    title?: string;
    file_path?: string;
    page_number?: number;
    section_title?: string;
    content?: string;
  } | null;
  neighbors: any[];
  relations: Array<{
    source_id: string;
    target_id: string;
    relation_type: string;
    description?: string;
  }>;
}

interface NodeInspectorProps {
  nodeId: string | null;
  onClose: () => void;
  onViewProvenance: (nodeId: string) => void;
}

export const NodeInspector: React.FC<NodeInspectorProps> = ({
  nodeId,
  onClose,
  onViewProvenance,
}) => {
  const [data, setData] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!nodeId) {
      setData(null);
      return;
    }

    setLoading(true);
    fetch(apiUrl(`/api/nodes/${encodeURIComponent(nodeId)}`))
      .then((res) => res.json())
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch node detail", err);
        setLoading(false);
      });
  }, [nodeId]);

  if (!nodeId) return null;

  return (
    <aside className="absolute inset-0 md:static w-full md:w-96 border-l border-slate-800 bg-slate-900/95 backdrop-blur flex flex-col h-full shrink-0 shadow-2xl z-20 transition-all duration-300">
      {/* Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <h2 className="font-semibold text-xs uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <Network className="w-4 h-4 text-indigo-400" />
          Thông Tin Neuron
        </h2>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7 text-slate-400 hover:text-white">
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="p-5 flex-1 overflow-y-auto custom-scrollbar space-y-4 text-xs">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-slate-500">
            <span className="animate-spin mr-2">◷</span> Đang tải neuron...
          </div>
        ) : data?.node ? (
          <>
            {/* Title & Badge */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Badge variant="purple" className="uppercase font-bold text-[10px]">
                  {data.node.node_type}
                </Badge>
                {data.node.is_hub ? (
                  <Badge variant="warning" className="text-[10px]">
                    HUB TRỌNG YẾU
                  </Badge>
                ) : null}
              </div>
              <h3 className="text-base font-bold text-white leading-snug">{data.node.label}</h3>
              <p className="text-slate-400 text-[11px] font-mono break-all bg-slate-950 p-1.5 rounded border border-slate-800/80">
                {data.node.id}
              </p>
            </div>

            {/* Summary Box */}
            <div className="p-3.5 bg-slate-950/80 rounded-xl border border-slate-800 space-y-1.5">
              <span className="text-slate-400 font-semibold text-[10px] uppercase tracking-wider block">
                Tóm Tắt Khái Niệm
              </span>
              <p className="text-slate-200 leading-relaxed text-xs">{data.node.summary}</p>
            </div>

            {/* Relations */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400 font-semibold text-[10px] uppercase tracking-wider">
                  Mối Quan Hệ Thần Kinh ({data.relations.length})
                </span>
              </div>

              <div className="space-y-1.5 max-h-56 overflow-y-auto custom-scrollbar">
                {data.relations.length === 0 ? (
                  <p className="text-slate-500 italic text-[11px]">Không có liên kết trực tiếp</p>
                ) : (
                  data.relations.map((r, idx) => {
                    const isOutbound = r.source_id === data.node.id;
                    const neighborId = isOutbound ? r.target_id : r.source_id;
                    return (
                      <div
                        key={idx}
                        className="p-2.5 rounded-lg bg-slate-850 bg-slate-800/50 border border-slate-700/50 flex flex-col gap-1 hover:border-slate-600 transition"
                      >
                        <div className="flex items-center justify-between gap-1 text-[11px]">
                          <span className="font-mono text-slate-200 truncate flex items-center gap-1">
                            {isOutbound ? (
                              <ArrowRight className="w-3 h-3 text-indigo-400 shrink-0" />
                            ) : (
                              <ArrowLeft className="w-3 h-3 text-cyan-400 shrink-0" />
                            )}
                            {neighborId}
                          </span>
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-slate-700/80 text-slate-300 shrink-0">
                            {r.relation_type}
                          </span>
                        </div>
                        {r.description ? (
                          <p className="text-[10px] text-slate-400 italic pl-4">
                            {r.description}
                          </p>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Provenance Badge */}
            <div className="p-3 bg-indigo-950/20 rounded-xl border border-indigo-500/20 text-indigo-300 text-[11px] flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>
                Nguồn: {data.provenance?.title || "AST Code / Ingestion Trực Tiếp"}
              </span>
            </div>
          </>
        ) : (
          <p className="text-slate-400">Không tìm thấy thông tin neuron.</p>
        )}
      </div>

      {/* Footer Actions */}
      <div className="p-4 border-t border-slate-800 bg-slate-950/60 flex gap-2">
        <Button
          onClick={() => onViewProvenance(nodeId)}
          className="w-full flex items-center justify-center gap-2"
        >
          <FileSearch className="w-3.5 h-3.5" />
          Soi Dẫn Chứng Nguyên Văn
        </Button>
      </div>
    </aside>
  );
};
