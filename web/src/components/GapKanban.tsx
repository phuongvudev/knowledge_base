"use client";

import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, Clock, RefreshCw, Lightbulb, Check } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { apiUrl } from "@/lib/api";

export interface KnowledgeGap {
  id: number;
  project_id: string;
  missing_item: string;
  reason: string;
  suggested_action?: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at?: string;
}

interface GapKanbanProps {
  projectId: string;
}

export const GapKanban: React.FC<GapKanbanProps> = ({ projectId }) => {
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchGaps = async () => {
    setLoading(true);
    try {
      const url = apiUrl(`/api/gaps?project_id=${encodeURIComponent(projectId)}`);
      const res = await fetch(url);
      const data = await res.json();
      setGaps(data.gaps || []);
    } catch (err) {
      console.error("Failed to fetch gaps", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGaps();
  }, [projectId]);

  const handleResolve = async (id: number) => {
    try {
      await fetch(apiUrl(`/api/gaps/${id}/resolve`), { method: "POST" });
      setGaps((prev) =>
        prev.map((g) => (g.id === id ? { ...g, status: "resolved" } : g))
      );
    } catch (err) {
      console.error("Failed to resolve gap", err);
    }
  };

  const pendingGaps = gaps.filter((g) => g.status === "open");
  const resolvedGaps = gaps.filter((g) => g.status === "resolved");

  return (
    <div className="flex-1 p-4 sm:p-8 overflow-y-auto custom-scrollbar">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2 text-white">
              <AlertTriangle className="w-6 h-6 text-amber-400" />
              Bảng Quản Lý Lỗ Hổng Tri Thức (Gap Kanban Board)
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Các mắt xích tài liệu bị khuyết, API thiếu spec do AI Agent tự động phát hiện trong quá trình vận hành.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchGaps}
            disabled={loading}
            className="flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Làm Mới
          </Button>
        </div>

        {/* 2-Column Kanban Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 items-start">
          {/* Column 1: Pending */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col min-h-[400px]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                Cần Bổ Sung ({pendingGaps.length})
              </h3>
              <Badge variant="warning">{pendingGaps.length} LỖ HỔNG</Badge>
            </div>

            <div className="space-y-3 flex-1 overflow-y-auto custom-scrollbar">
              {pendingGaps.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-xs flex flex-col items-center justify-center space-y-2">
                  <CheckCircle className="w-8 h-8 text-emerald-500/40" />
                  <span>Không có lỗ hổng kiến thức nào. Hệ thống toàn vẹn 100%!</span>
                </div>
              ) : (
                pendingGaps.map((gap) => (
                  <div
                    key={gap.id}
                    className="p-4 bg-slate-900 border border-amber-500/30 rounded-xl space-y-2.5 shadow-lg shadow-amber-500/5 hover:border-amber-500/60 transition"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-amber-300 text-xs break-all">
                        {gap.missing_item}
                      </span>
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        {gap.project_id}
                      </Badge>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed">{gap.reason}</p>

                    {gap.suggested_action && (
                      <div className="p-2.5 rounded-lg bg-indigo-950/30 border border-indigo-500/20 text-indigo-300 text-[11px] flex items-start gap-1.5">
                        <Lightbulb className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                        <span>{gap.suggested_action}</span>
                      </div>
                    )}

                    <Button
                      variant="success"
                      size="sm"
                      onClick={() => handleResolve(gap.id)}
                      className="w-full flex items-center justify-center gap-1.5 text-xs h-7"
                    >
                      <Check className="w-3.5 h-3.5" /> Đánh Dấu Đã Giải Quyết
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Column 2: Resolved */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col min-h-[400px]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                Đã Khắc Phục ({resolvedGaps.length})
              </h3>
              <Badge variant="success">{resolvedGaps.length} ĐÃ XONG</Badge>
            </div>

            <div className="space-y-3 flex-1 overflow-y-auto custom-scrollbar">
              {resolvedGaps.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-xs">
                  Chưa có lỗ hổng nào được giải quyết.
                </div>
              ) : (
                resolvedGaps.map((gap) => (
                  <div
                    key={gap.id}
                    className="p-3.5 bg-slate-900/40 border border-slate-800 rounded-xl space-y-1.5 opacity-70 hover:opacity-100 transition"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-slate-400 text-xs line-through break-all">
                        {gap.missing_item}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {gap.project_id}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">{gap.reason}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
