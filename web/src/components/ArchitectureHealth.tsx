"use client";

import React, { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";
import {
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  FileText,
  Download,
  ExternalLink,
  ChevronRight,
  Code2,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

interface DependencyCycle {
  id: string;
  cycleLength: number;
  path: string[];
  nodes: { id: string; label: string; file_path?: string; node_type: string }[];
}

interface OrphanNode {
  id: string;
  label: string;
  node_type: string;
  summary: string;
  file_path?: string;
  line?: number;
}

interface AuditReport {
  project_id: string;
  timestamp: string;
  healthScore: number;
  totalNodes: number;
  totalEdges: number;
  cycles: DependencyCycle[];
  orphanNodes: OrphanNode[];
  summary: {
    cycleCount: number;
    orphanCount: number;
    status: "healthy" | "warning" | "critical";
  };
}

interface ArchitectureHealthProps {
  projectId: string;
  onSelectNode?: (nodeId: string) => void;
}

export const ArchitectureHealth: React.FC<ArchitectureHealthProps> = ({
  projectId,
  onSelectNode,
}) => {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchAudit = async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/diagnostics?project_id=${encodeURIComponent(projectId)}`));
      const data = await res.json();
      setReport(data);
    } catch (err) {
      console.error("Failed to fetch architecture audit", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAudit();
  }, [projectId]);

  const downloadReport = () => {
    window.open(apiUrl(`/api/export?project_id=${encodeURIComponent(projectId)}&format=report`), "_blank");
  };

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        Vui lòng chọn một dự án để xem báo cáo sức khỏe kiến trúc.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2.5">
            <ShieldCheck className="w-6 h-6 text-indigo-400" />
            Kiểm Định & Sức Khỏe Kiến Trúc
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Chẩn đoán phụ thuộc vòng (Circular Dependencies), phát hiện mã mồ côi và đánh giá sức khỏe đồ thị mã nguồn.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={downloadReport}
            className="h-8 gap-1.5 text-xs bg-slate-900 border-slate-700 text-slate-200 hover:text-white"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            <span>Xuất Báo Cáo (.md)</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={fetchAudit}
            disabled={isLoading}
            className="h-8 gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            <span>Chẩn đoán lại</span>
          </Button>
        </div>
      </div>

      {report && (
        <>
          {/* Top KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Health Score */}
            <Card className="bg-slate-900/80 border-slate-800">
              <CardHeader className="pb-2">
                <CardDescription className="text-xs text-slate-400">Điểm Sức Khỏe Kiến Trúc</CardDescription>
                <CardTitle className="text-3xl font-extrabold flex items-center gap-2">
                  <span
                    className={
                      report.healthScore >= 85
                        ? "text-emerald-400"
                        : report.healthScore >= 60
                        ? "text-amber-400"
                        : "text-rose-400"
                    }
                  >
                    {report.healthScore}
                  </span>
                  <span className="text-sm font-normal text-slate-500">/ 100</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Badge
                  variant={
                    report.summary.status === "healthy"
                      ? "success"
                      : report.summary.status === "warning"
                      ? "warning"
                      : "destructive"
                  }
                  className="uppercase text-[10px]"
                >
                  {report.summary.status}
                </Badge>
              </CardContent>
            </Card>

            {/* Cycles */}
            <Card className="bg-slate-900/80 border-slate-800">
              <CardHeader className="pb-2">
                <CardDescription className="text-xs text-slate-400">Chu Trình Phụ Thuộc (Cycles)</CardDescription>
                <CardTitle className="text-3xl font-extrabold text-amber-400">
                  {report.summary.cycleCount}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-[11px] text-slate-400">
                  {report.summary.cycleCount === 0
                    ? "Rất tốt! Không phát hiện import chéo."
                    : "Cần xử lý để tránh rò rỉ bộ nhớ & lỗi khởi tạo."}
                </p>
              </CardContent>
            </Card>

            {/* Orphan Nodes */}
            <Card className="bg-slate-900/80 border-slate-800">
              <CardHeader className="pb-2">
                <CardDescription className="text-xs text-slate-400">Mã Mồ Côi (In-degree = 0)</CardDescription>
                <CardTitle className="text-3xl font-extrabold text-cyan-400">
                  {report.summary.orphanCount}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-[11px] text-slate-400">Thành phần chưa có kết nối gọi đến</p>
              </CardContent>
            </Card>

            {/* Graph Size */}
            <Card className="bg-slate-900/80 border-slate-800">
              <CardHeader className="pb-2">
                <CardDescription className="text-xs text-slate-400">Quy Mô Đồ Thị</CardDescription>
                <CardTitle className="text-2xl font-bold text-slate-200">
                  {report.totalNodes} <span className="text-xs text-slate-500 font-normal">nút</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-[11px] text-slate-400">{report.totalEdges} mối quan hệ phụ thuộc</p>
              </CardContent>
            </Card>
          </div>

          {/* Section 1: Circular Dependencies */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              Chi Tiết Chu Trình Phụ Thuộc (Circular Dependencies)
            </h3>

            {report.cycles.length === 0 ? (
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 text-xs text-slate-400 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                Kiến trúc module sạch! Không phát hiện phụ thuộc vòng nào trong dự án.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {report.cycles.map((c, idx) => (
                  <div
                    key={c.id || idx}
                    className="p-3.5 rounded-xl bg-slate-900/80 border border-amber-500/20 shadow-md space-y-2.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-amber-300 font-semibold flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        Chu trình #{idx + 1} ({c.cycleLength} bước)
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono text-slate-300">
                      {c.path.map((nodeId, pIdx) => (
                        <React.Fragment key={pIdx}>
                          <button
                            onClick={() => onSelectNode?.(nodeId)}
                            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-indigo-600/30 text-indigo-300 hover:text-white border border-slate-700/60 transition"
                          >
                            {nodeId}
                          </button>
                          {pIdx < c.path.length - 1 && (
                            <ChevronRight className="w-3.5 h-3.5 text-amber-500" />
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 2: Potential Dead Code / Orphan Nodes */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Code2 className="w-4 h-4 text-cyan-400" />
              Thành Phần Mồ Côi / Tiềm Ẩn Mã Dư Thừa ({report.orphanNodes.length})
            </h3>

            {report.orphanNodes.length === 0 ? (
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 text-xs text-slate-400 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                Toàn bộ các thành phần trong dự án đều có liên kết hoặc người gọi đến.
              </div>
            ) : (
              <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-900/60">
                <div className="max-h-80 overflow-y-auto divide-y divide-slate-800">
                  {report.orphanNodes.map((o) => (
                    <div
                      key={o.id}
                      className="p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-slate-800/40 transition"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white truncate">{o.label}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 border border-slate-700">
                            {o.node_type}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 truncate mt-0.5">{o.summary}</p>
                        {o.file_path && (
                          <span className="text-[10px] text-slate-500 font-mono">
                            {o.file_path} {o.line ? `:${o.line}` : ""}
                          </span>
                        )}
                      </div>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSelectNode?.(o.id)}
                        className="h-7 text-xs text-indigo-400 hover:text-white shrink-0"
                      >
                        <span>Xem chi tiết</span>
                        <ExternalLink className="w-3 h-3 ml-1" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
