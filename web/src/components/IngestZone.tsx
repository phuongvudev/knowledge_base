"use client";

import React, { useState, useEffect } from "react";
import {
  FolderSync,
  FolderOpen,
  RefreshCw,
  BookmarkPlus,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Link2,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { apiUrl } from "@/lib/api";

interface IngestZoneProps {
  projectId: string;
  onIngestSuccess: () => void;
}

function slugifyId(prefix: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `${prefix}:${slug || "untitled"}`;
}

export const IngestZone: React.FC<IngestZoneProps> = ({ projectId, onIngestSuccess }) => {
  // 1. Directory Sync & Batch Ingest State
  const [dirPath, setDirPath] = useState("");
  const [detectedCount, setDetectedCount] = useState<number>(0);
  const [forceReindex, setForceReindex] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // 2. Architectural Note / Rule State
  const [nodeType, setNodeType] = useState<"decision" | "rule" | "concept">("decision");
  const [title, setTitle] = useState("");
  const [customId, setCustomId] = useState("");
  const [domain, setDomain] = useState("architecture");
  const [summary, setSummary] = useState("");
  const [linkedTargetId, setLinkedTargetId] = useState("");
  const [relationType, setRelationType] = useState("GOVERNS");
  const [isSavingNote, setIsSavingNote] = useState(false);

  // 3. Execution Logs
  const [logs, setLogs] = useState<Array<{ text: string; type: "info" | "success" | "error" }>>([]);

  const addLog = (text: string, type: "info" | "success" | "error" = "info") => {
    setLogs((prev) => [{ text, type }, ...prev]);
  };

  // Auto-detect project root directory from existing indexed files
  useEffect(() => {
    if (!projectId) return;
    fetch(apiUrl(`/api/project-root?project_id=${encodeURIComponent(projectId)}`))
      .then((r) => r.json())
      .then((data) => {
        if (data.dir_path) {
          setDirPath(data.dir_path);
        } else {
          setDirPath("");
        }
        setDetectedCount(data.indexed_files || 0);
      })
      .catch(() => {
        /* ignore offline */
      });
  }, [projectId]);

  // Auto-generate node ID slug from title
  const effectiveNodeId = customId.trim() || slugifyId(nodeType, title);

  const handleSync = async (mode: "sync" | "batch") => {
    if (mode === "batch" && !dirPath.trim()) {
      addLog("Vui lòng nhập đường dẫn thư mục tuyệt đối trên máy (ví dụ: /Volumes/Data/...).", "error");
      return;
    }

    setIsSyncing(true);
    addLog(
      mode === "sync"
        ? `🔄 Đang kiểm tra thay đổi mã nguồn (Incremental Sync) cho dự án '${projectId}'...`
        : `📂 Đang quét & lập chỉ mục toàn bộ thư mục '${dirPath}'...`,
      "info"
    );

    try {
      const res = await fetch(apiUrl("/api/sync"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          dir_path: dirPath.trim() || undefined,
          mode,
          force: forceReindex,
        }),
      });
      const result = await res.json();
      if (res.ok && result.success) {
        const cleanMsg = String(result.message || "")
          .replace(/\n*\[kb:[^\]]+\]/g, "")
          .trim();
        addLog(`✓ ${cleanMsg}`, "success");
        onIngestSuccess();
      } else {
        addLog(`✗ Lỗi đồng bộ: ${result.error || "Không xác định"}`, "error");
      }
    } catch (err: any) {
      addLog(`✗ Lỗi kết nối máy chủ: ${err.message}`, "error");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !summary.trim()) {
      addLog("Vui lòng nhập Tiêu đề và Nội dung quy tắc / quyết định kiến trúc.", "error");
      return;
    }

    setIsSavingNote(true);
    addLog(`📝 Đang ghi nhận nút tri thức '${effectiveNodeId}'...`, "info");

    try {
      const links_to = linkedTargetId.trim()
        ? [{ target_id: linkedTargetId.trim(), relation: relationType }]
        : undefined;

      const res = await fetch(apiUrl("/api/nodes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          id: effectiveNodeId,
          label: title.trim(),
          node_type: nodeType,
          domain: domain.trim() || "architecture",
          summary: summary.trim(),
          links_to,
        }),
      });

      const result = await res.json();
      if (res.ok && result.success) {
        addLog(
          `✓ Đã lưu nút '${result.node_id}' (${title.trim()}) vào đồ thị dự án '${projectId}'!`,
          "success"
        );
        setTitle("");
        setCustomId("");
        setSummary("");
        setLinkedTargetId("");
        onIngestSuccess();
      } else {
        addLog(`✗ Không thể lưu ghi chú: ${result.error || "Lỗi không xác định"}`, "error");
      }
    } catch (err: any) {
      addLog(`✗ Lỗi kết nối: ${err.message}`, "error");
    } finally {
      setIsSavingNote(false);
    }
  };

  return (
    <div className="flex-1 p-4 sm:p-8 overflow-y-auto custom-scrollbar">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2 text-white">
            <FolderSync className="w-6 h-6 text-indigo-400" />
            Đồng Bộ Thư Mục & Ghi Chú Kiến Trúc
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Đồng bộ trực tiếp mã nguồn trên ổ cứng (giữ nguyên đường dẫn thật cho AI Agent) hoặc ghi nhận nhanh Quyết định Kiến trúc (ADR) & Quy tắc Nghiệp vụ.
          </p>
        </div>

        {/* CARD 1: LOCAL DIRECTORY SYNC & BATCH INGEST */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-indigo-400" />
                  Đồng Bộ Mã Nguồn & Thư Mục Local
                </CardTitle>
                <CardDescription>
                  Quét trực tiếp từ đường dẫn gốc trên máy tính (tự động tôn trọng <code className="text-slate-300">.kbignore</code> và bỏ qua file không đổi qua SHA-256)
                </CardDescription>
              </div>
              <Badge variant="secondary" className="font-mono text-[11px]">
                {projectId}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[11px] font-semibold text-slate-300">
                  Đường dẫn thư mục dự án trên máy (Absolute Path)
                </label>
                {detectedCount > 0 && (
                  <span className="text-[11px] text-emerald-400 font-mono">
                    ✓ Tự động nhận diện từ {detectedCount} tệp đã lập chỉ mục
                  </span>
                )}
              </div>
              <Input
                value={dirPath}
                onChange={(e) => setDirPath(e.target.value)}
                placeholder="/Volumes/Data/station/personal/projects/my_project"
                className="font-mono text-xs"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={forceReindex}
                  onChange={(e) => setForceReindex(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                />
                Ép buộc phân tích lại toàn bộ (<code className="text-slate-300">force: true</code>, bỏ qua kiểm tra SHA-256)
              </label>

              <div className="flex items-center gap-2.5">
                <Button
                  variant="outline"
                  onClick={() => handleSync("sync")}
                  disabled={isSyncing}
                  className="h-9 text-xs gap-1.5 border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200"
                  title="Chỉ cập nhật các file đã sửa, xoá các file đã bị xoá và quét thêm file mới"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${isSyncing ? "animate-spin" : ""}`} />
                  Đồng Bộ Nhanh (kb_sync)
                </Button>

                <Button
                  onClick={() => handleSync("batch")}
                  disabled={isSyncing || !dirPath.trim()}
                  className="h-9 text-xs gap-1.5"
                >
                  <FolderSync className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`} />
                  Quét & Nạp Thư Mục
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* CARD 2: ARCHITECTURAL DECISION & BUSINESS RULE RECORDER */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookmarkPlus className="w-4 h-4 text-amber-400" />
              Ghi Chú Quyết Định Kiến Trúc (ADR) & Quy Tắc Nghiệp Vụ
            </CardTitle>
            <CardDescription>
              Tạo trực tiếp nút tri thức bậc cao (<code className="text-slate-300">decision</code>, <code className="text-slate-300">rule</code>, <code className="text-slate-300">concept</code>) để AI Agent tra cứu khi lập trình
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveNote} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    Loại Tri Thức
                  </label>
                  <select
                    value={nodeType}
                    onChange={(e) => setNodeType(e.target.value as any)}
                    className="w-full h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="decision">Quyết định Kiến trúc (decision)</option>
                    <option value="rule">Quy tắc Nghiệp vụ (rule)</option>
                    <option value="concept">Khái niệm Domain (concept)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    Domain / Phân hệ
                  </label>
                  <Input
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="architecture, finance, security..."
                    className="h-9 text-xs"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    Mã Định Danh Nút (Tự động tạo)
                  </label>
                  <Input
                    value={customId}
                    onChange={(e) => setCustomId(e.target.value)}
                    placeholder={effectiveNodeId}
                    className="h-9 text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Tiêu đề Quyết định / Quy tắc
                </label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ví dụ: Sử dụng ObjectBox cho Local Persistence hoặc Không lưu số dư dạng Float"
                  className="text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Nội dung chi tiết (Lý do, bối cảnh, quy định bắt buộc cho AI Agent)
                </label>
                <Textarea
                  rows={4}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="Mô tả rõ quy tắc kiến trúc hoặc quyết định thiết kế để Agent luôn tuân thủ khi tìm kiếm bằng kb_search..."
                  className="text-xs"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                    <Link2 className="w-3 h-3 text-indigo-400" />
                    Liên kết tới Nút mục tiêu (Tuỳ chọn)
                  </label>
                  <Input
                    value={linkedTargetId}
                    onChange={(e) => setLinkedTargetId(e.target.value)}
                    placeholder="Ví dụ: module:entities_money_dart hoặc project:budgetable-v2"
                    className="h-9 text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    Loại Quan Hệ
                  </label>
                  <select
                    value={relationType}
                    onChange={(e) => setRelationType(e.target.value)}
                    className="w-full h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  >
                    <option value="GOVERNS">GOVERNS (Chi phối)</option>
                    <option value="CONSTRAINS">CONSTRAINS (Ràng buộc)</option>
                    <option value="DEPENDS_ON">DEPENDS_ON (Phụ thuộc)</option>
                    <option value="IMPLEMENTS">IMPLEMENTS (Hiện thực)</option>
                  </select>
                </div>
              </div>

              <Button
                type="submit"
                disabled={isSavingNote || !title.trim() || !summary.trim()}
                className="w-full h-9 flex items-center justify-center gap-2 text-xs"
              >
                {isSavingNote ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" /> Đang Lưu Nút Tri Thức...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" /> Lưu Vào Đồ Thị Tri Thức ({effectiveNodeId})
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* LIVE LOGS CARD */}
        {logs.length > 0 && (
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between">
                <span>Nhật Ký Đồng Bộ & Ghi Nhận</span>
                <Badge variant="secondary">{logs.length} sự kiện</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="text-xs font-mono bg-slate-950 p-4 rounded-lg space-y-1.5 text-slate-300 max-h-48 overflow-y-auto custom-scrollbar border border-slate-800">
                {logs.map((log, index) => (
                  <div
                    key={index}
                    className={`flex items-start gap-2 ${
                      log.type === "success"
                        ? "text-emerald-400 font-semibold"
                        : log.type === "error"
                        ? "text-red-400 font-semibold"
                        : "text-slate-300"
                    }`}
                  >
                    {log.type === "success" ? (
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5 text-emerald-400" />
                    ) : log.type === "error" ? (
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-400" />
                    ) : (
                      <span className="text-slate-500 shrink-0">›</span>
                    )}
                    <span className="whitespace-pre-wrap">{log.text}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};
