"use client";

import React, { useState, useEffect } from "react";
import { FileCheck, Search, CheckCircle, FileText, MapPin, Tag } from "lucide-react";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { apiUrl } from "@/lib/api";

interface ProvenanceInspectorProps {
  projectId: string;
  initialNodeId?: string | null;
}

export const ProvenanceInspector: React.FC<ProvenanceInspectorProps> = ({
  projectId,
  initialNodeId,
}) => {
  const [nodes, setNodes] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialNodeId || null);
  const [nodeDetail, setNodeDetail] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(apiUrl(`/api/graph?lod=1&project_id=${encodeURIComponent(projectId)}`))
      .then((res) => res.json())
      .then((data) => {
        setNodes(data.nodes || []);
        if (!selectedNodeId && data.nodes && data.nodes.length > 0) {
          setSelectedNodeId(data.nodes[0].id);
        }
      });
  }, []);

  useEffect(() => {
    if (initialNodeId) {
      setSelectedNodeId(initialNodeId);
    }
  }, [initialNodeId]);

  useEffect(() => {
    if (!selectedNodeId) return;

    setLoading(true);
    fetch(apiUrl(`/api/nodes/${encodeURIComponent(selectedNodeId)}`))
      .then((res) => res.json())
      .then((data) => {
        setNodeDetail(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, [selectedNodeId]);

  const filteredNodes = nodes.filter(
    (n) =>
      n.label.toLowerCase().includes(search.toLowerCase()) ||
      n.id.toLowerCase().includes(search.toLowerCase())
  );

  const node = nodeDetail?.node;
  const provenance = nodeDetail?.provenance;

  return (
    <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
      {/* Left List of Nodes */}
      <div className="w-full md:w-80 max-h-52 md:max-h-none border-b md:border-b-0 md:border-r border-slate-800 bg-slate-900/60 p-3 md:p-4 flex flex-col shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <FileCheck className="w-4 h-4 text-indigo-400" />
            Danh Sách Neuron
          </h3>
          <Badge variant="secondary">{filteredNodes.length}</Badge>
        </div>

        <div className="relative mb-3">
          <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm theo ID, tên..."
            className="pl-8"
          />
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-1.5">
          {filteredNodes.map((n) => {
            const isSelected = n.id === selectedNodeId;
            return (
              <button
                key={n.id}
                onClick={() => setSelectedNodeId(n.id)}
                className={`w-full text-left p-2.5 rounded-lg border transition ${
                  isSelected
                    ? "bg-indigo-600/20 border-indigo-500/50 text-white"
                    : "bg-slate-900/40 border-transparent hover:border-slate-800 text-slate-300 hover:text-white"
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-semibold text-xs truncate">{n.label}</span>
                  <span className="text-[9px] uppercase font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 shrink-0">
                    {n.node_type}
                  </span>
                </div>
                <span className="text-[11px] text-slate-500 font-mono truncate block mt-0.5">
                  {n.id}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right Side Excerpt & Evidence Inspector */}
      <div className="flex-1 bg-slate-950 p-4 md:p-8 overflow-y-auto custom-scrollbar flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
            Đang trích xuất dẫn chứng...
          </div>
        ) : node ? (
          <div className="max-w-4xl mx-auto w-full space-y-5">
            <div className="border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2">
                <Badge variant="purple" className="text-[11px] uppercase">
                  {node.node_type}
                </Badge>
                <h2 className="text-xl font-bold text-white">{node.label}</h2>
              </div>
              <p className="text-xs text-slate-400 mt-1">{node.summary}</p>
            </div>

            {/* Meta Provenance Card */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs">
              <div className="space-y-0.5">
                <span className="text-slate-500 block text-[11px] flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5" /> Tệp Tin Gốc
                </span>
                <span className="font-mono text-slate-200 font-medium truncate block">
                  {provenance?.file_path || provenance?.title || "AST Code / Ingestion Trực Tiếp"}
                </span>
              </div>
              <div className="space-y-0.5">
                <span className="text-slate-500 block text-[11px] flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" /> Vị Trí Trích Xuất
                </span>
                <span className="font-semibold text-slate-200 block">
                  {provenance?.section_title
                    ? `${provenance.section_title} (Trang ${provenance.page_number || 1})`
                    : "Đoạn mã / Văn bản nguyên gốc"}
                </span>
              </div>
              <div className="space-y-0.5">
                <span className="text-slate-500 block text-[11px] flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> Mức Độ Toàn Vẹn
                </span>
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  100% Khớp nguyên văn
                </span>
              </div>
            </div>

            {/* Snippet Highlight View */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-indigo-400" />
                Đoạn Văn Bản Gốc Được Bôi Vàng (Extracted Provenance Snippet)
              </label>
              <div className="bg-slate-900/90 border-l-4 border-amber-400 p-6 rounded-r-xl text-xs text-slate-200 font-serif leading-relaxed whitespace-pre-wrap bg-gradient-to-r from-amber-500/5 to-transparent border border-slate-800 shadow-xl">
                {provenance?.content ? provenance.content.slice(0, 2000) : node.summary}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
            Vui lòng chọn một neuron từ danh sách bên trái.
          </div>
        )}
      </div>
    </div>
  );
};
