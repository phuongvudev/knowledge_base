"use client";

import React, { useEffect, useState } from "react";
import { X, Trash2, Pencil, Check } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { apiUrl } from "@/lib/api";

interface ProjectRow {
  id: string;
  name: string;
  description?: string;
  domain?: string;
  node_count: number;
}

interface ProjectManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export const ProjectManager: React.FC<ProjectManagerProps> = ({ isOpen, onClose, onChanged }) => {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [p, j] = await Promise.all([
        fetch(apiUrl("/api/projects")).then((r) => r.json()),
        fetch(apiUrl("/api/jobs")).then((r) => r.json()),
      ]);
      setRows(p.projectDetails || []);
      setRunning(new Set((j.jobs || []).filter((x: any) => x.status === "running").map((x: any) => x.project_id)));
    } catch {
      /* backend offline */
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [isOpen]);

  if (!isOpen) return null;

  const rename = async (r: ProjectRow) => {
    if (!draft.trim()) return;
    // POST upserts, so re-posting an id renames it
    await fetch(apiUrl("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: r.id, name: draft, description: r.description, domain: r.domain }),
    });
    setEditing(null);
    await load();
    onChanged();
  };

  const remove = async (r: ProjectRow) => {
    if (!window.confirm(`Xoá dự án "${r.name}" cùng ${r.node_count} node và toàn bộ nguồn? Không thể hoàn tác.`)) return;
    setError(null);
    const res = await fetch(apiUrl(`/api/projects?id=${encodeURIComponent(r.id)}`), { method: "DELETE" });
    if (!res.ok) setError((await res.json()).error || "Xoá thất bại");
    await load();
    onChanged();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">Quản Lý Dự Án</h3>
          <button onClick={onClose} aria-label="Đóng" className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <ul className="divide-y divide-slate-800 max-h-96 overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-2 text-xs">
              <div className="flex-1 min-w-0">
                {editing === r.id ? (
                  <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-xs" autoFocus />
                ) : (
                  <div className="text-slate-100 font-medium truncate">{r.name}</div>
                )}
                <div className="text-[10px] text-slate-500 font-mono">
                  {r.id} · {r.node_count} nodes
                  {running.has(r.id) && <span className="text-indigo-400"> · đang lập chỉ mục</span>}
                </div>
              </div>
              {editing === r.id ? (
                <Button size="sm" variant="outline" onClick={() => rename(r)} aria-label="Lưu tên">
                  <Check className="w-3.5 h-3.5" />
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { setEditing(r.id); setDraft(r.name); }} aria-label="Đổi tên">
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={running.has(r.id)} onClick={() => remove(r)} aria-label="Xoá dự án">
                <Trash2 className="w-3.5 h-3.5 text-red-400" />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
