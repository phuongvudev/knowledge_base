"use client";

import React, { useState } from "react";
import { FolderPlus, X, Sparkles, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { apiUrl } from "@/lib/api";

interface CreateProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onProjectCreated: (projectId: string) => void;
}

export const CreateProjectDialog: React.FC<CreateProjectDialogProps> = ({
  isOpen,
  onClose,
  onProjectCreated,
}) => {
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [domain, setDomain] = useState("general");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleNameChange = (val: string) => {
    setName(val);
    if (!projectId || projectId === slugify(name)) {
      setProjectId(slugify(val));
    }
  };

  const slugify = (text: string) => {
    return text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId.trim() || !name.trim()) {
      setError("Vui lòng nhập đầy đủ Mã dự án và Tên dự án.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(apiUrl("/api/projects"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId.trim(),
          name: name.trim(),
          description: description.trim(),
          domain: domain.trim(),
        }),
      });

      const data = await res.json();
      if (data.success) {
        onProjectCreated(data.project.id);
        onClose();
      } else {
        setError(data.error || "Không thể tạo dự án.");
      }
    } catch (err: any) {
      setError(err.message || "Lỗi kết nối máy chủ.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center">
              <FolderPlus className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white flex items-center gap-2">
                Tạo Không Gian Dự Án Mới
                <Badge variant="purple" className="text-[10px]">MCP Project</Badge>
              </h3>
              <p className="text-[11px] text-slate-400">
                Khởi tạo một vùng nhớ tri thức neuron độc lập cho dự án
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              Tên Dự Án (Display Name) <span className="text-red-400">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Cổng Thanh Toán Quốc Tế V2"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Mã Định Danh (Project ID) <span className="text-red-400">*</span>
              </label>
              <Input
                value={projectId}
                onChange={(e) => setProjectId(slugify(e.target.value))}
                placeholder="e.g. payment-v2"
                className="font-mono text-xs"
              />
              <span className="text-[10px] text-slate-500 mt-0.5 block">
                Dùng trong lệnh gọi MCP của Agent
              </span>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Domain Nghiệp Vụ Chính
              </label>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="e.g. finance, security, ecommerce"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              Mô Tả Mục Tiêu & Phạm Vi Dự Án
            </label>
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Mô tả tóm lược vai trò, kiến trúc hoặc các dịch vụ lõi của dự án này..."
            />
          </div>

          {/* Dialog Actions */}
          <div className="pt-2 flex items-center justify-end gap-2.5 border-t border-slate-800">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Hủy Bỏ
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isSubmitting || !name.trim() || !projectId.trim()}
              className="flex items-center gap-1.5 shadow-lg shadow-indigo-500/20"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {isSubmitting ? "Đang Khởi Tạo..." : "Khởi Tạo Dự Án"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
