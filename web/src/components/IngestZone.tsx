"use client";

import React, { useState, useRef } from "react";
import { UploadCloud, FileUp, Zap, FileText, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
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

export const IngestZone: React.FC<IngestZoneProps> = ({ projectId, onIngestSuccess }) => {
  const [domain, setDomain] = useState("auto");
  const [fileName, setFileName] = useState("decision_doc.md");
  const [rawText, setRawText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [logs, setLogs] = useState<Array<{ text: string; type: "info" | "success" | "error" }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addLog = (text: string, type: "info" | "success" | "error" = "info") => {
    setLogs((prev) => [...prev, { text, type }]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
    }
  };

  const handleFiles = async (files: File[]) => {
    setIsProcessing(true);
    addLog(`🚀 Bắt đầu nạp ${files.length} tệp tin...`, "info");

    for (const file of files) {
      addLog(`📄 Đang đọc ${file.name} (${(file.size / 1024).toFixed(1)} KB)...`, "info");
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const content = e.target?.result as string;
          const res = await fetch(apiUrl("/api/ingest"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project_id: projectId,
              file_name: file.name,
              content: content,
              domain: domain,
            }),
          });
          const result = await res.json();
          if (result.success) {
            addLog(
              `✓ Hoàn tất ${file.name}: +${result.nodesCreated} nodes, +${result.edgesCreated} edges!`,
              "success"
            );
            onIngestSuccess();
          } else {
            addLog(`✗ Lỗi xử lý ${file.name}: ${result.error}`, "error");
          }
        } catch (err: any) {
          addLog(`✗ Lỗi kết nối: ${err.message}`, "error");
        } finally {
          setIsProcessing(false);
        }
      };

      reader.readAsText(file);
    }
  };

  const handleTextSubmit = async () => {
    if (!rawText.trim()) return;

    setIsProcessing(true);
    addLog(`⚙️ Đang phân tích cú pháp văn bản '${fileName}'...`, "info");

    try {
      const res = await fetch(apiUrl("/api/ingest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          file_name: fileName,
          content: rawText,
          domain: domain,
        }),
      });
      const result = await res.json();
      if (result.success) {
        addLog(
          `✓ Tiêu hóa thành công! Đã trích xuất +${result.nodesCreated} nodes và +${result.edgesCreated} liên kết neuron!`,
          "success"
        );
        setRawText("");
        onIngestSuccess();
      } else {
        addLog(`✗ Thất bại: ${result.error}`, "error");
      }
    } catch (err: any) {
      addLog(`✗ Lỗi kết nối: ${err.message}`, "error");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex-1 p-4 sm:p-8 overflow-y-auto custom-scrollbar">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2 text-white">
            <UploadCloud className="w-6 h-6 text-indigo-400" />
            Trạm Nạp Dữ Liệu Tự Động (Multi-Modal Ingestion Hub)
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Kéo thả tệp tin hoặc dán nội dung để engine tự động trích xuất thực thể, quan hệ, phát hiện lỗ hổng và lập chỉ mục FTS5.
          </p>
        </div>

        {/* Config and Input Card */}
        <Card>
          <CardHeader>
            <CardTitle>Cấu Hình Nguồn Dữ Liệu</CardTitle>
            <CardDescription>Thiết lập dự án và domain nghiệp vụ cho dữ liệu được nạp</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Mã Dự Án (Project ID)
                </label>
                <Input value={projectId} readOnly disabled />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Domain Nghiệp Vụ
                </label>
                <Input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="auto = tự phân loại, hoặc nhập: payment, legal..."
                />
              </div>
            </div>

            {/* Drag & Drop Area */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition flex flex-col items-center justify-center space-y-3 ${
                isDragging
                  ? "border-indigo-400 bg-indigo-500/10"
                  : "border-slate-700 hover:border-indigo-500/60 bg-slate-950/60"
              }`}
            >
              <div className="w-12 h-12 rounded-full bg-indigo-500/10 text-indigo-400 flex items-center justify-center shadow-lg shadow-indigo-500/10">
                <FileUp className="w-6 h-6" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">
                  Kéo thả file vào đây hoặc <span className="text-indigo-400 underline">chọn từ máy tính</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Hỗ trợ: PDF (.pdf), Word (.docx), Markdown (.md), Mã nguồn (.ts, .py, .js, .sql, .json)
                </p>
              </div>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileInputChange}
                className="hidden"
                multiple
              />
            </div>

            {/* Direct Paste Box */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-indigo-400" />
                  Hoặc dán trực tiếp văn bản / spec / quyết định kiến trúc:
                </label>
                <Input
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  className="w-48 h-7 text-[11px]"
                  placeholder="Tên tệp (vd: ADR-001.md)"
                />
              </div>
              <Textarea
                rows={5}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="Dán nội dung quy chế, tài liệu API, hoặc ghi chú cuộc họp tại đây..."
              />
            </div>

            <Button
              onClick={handleTextSubmit}
              disabled={isProcessing || !rawText.trim()}
              className="w-full h-9 flex items-center justify-center gap-2"
            >
              {isProcessing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" /> Đang Tiêu Hóa Dữ Liệu...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4" /> Bắt Đầu Tiêu Hóa Dữ Liệu
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Live Logs Card */}
        {logs.length > 0 && (
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between">
                <span>Tiến Trình Xử Lý Engine</span>
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
                    <span>{log.text}</span>
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
