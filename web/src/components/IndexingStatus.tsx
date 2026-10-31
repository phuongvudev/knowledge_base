"use client";

import React, { useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { apiUrl } from "@/lib/api";

interface Job {
  id: number;
  label: string;
  status: "running" | "done" | "error" | "cancelled";
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  current_file: string | null;
  error: string | null;
  started_at: number;
}

interface IndexingStatusProps {
  projectId: string;
  /** false: only the running-job banner; true: also the recent job list */
  history?: boolean;
  onJobFinished?: () => void;
}

export const IndexingStatus: React.FC<IndexingStatusProps> = ({ projectId, history = false, onJobFinished }) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const wasRunning = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    wasRunning.current = false;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl(`/api/jobs?project_id=${encodeURIComponent(projectId)}`));
        const data = await res.json();
        if (cancelled) return;
        const list: Job[] = data.jobs || [];
        setJobs(list);
        const running = list.some((j) => j.status === "running");
        if (wasRunning.current && !running) onJobFinished?.();
        wasRunning.current = running;
      } catch {
        /* backend offline: keep last state */
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const cancel = async (id: number) => {
    await fetch(apiUrl(`/api/jobs/cancel?id=${id}`), { method: "POST" });
  };

  const running = jobs.filter((j) => j.status === "running");
  const shown = history ? jobs : running;
  if (shown.length === 0) return null;

  return (
    <div className="space-y-2">
      {shown.map((j) => {
        const done = j.processed + j.skipped + j.failed;
        const pct = j.total ? Math.min(100, Math.round((done / j.total) * 100)) : 0;
        return (
          <div key={j.id} className="rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-slate-200 font-medium truncate">
                {j.status === "running" && <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />}
                {j.status === "done" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                {(j.status === "error" || j.status === "cancelled") && <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                {{ running: "Đang lập chỉ mục", done: "Hoàn tất", error: "Lỗi", cancelled: "Đã huỷ" }[j.status]}: {j.label}
              </span>
              <span className="text-slate-400 font-mono shrink-0 flex items-center gap-2">
                {done}/{j.total} · {pct}%
                {j.status === "running" && j.total > 1 && (
                  <button onClick={() => cancel(j.id)} className="text-red-400 hover:text-red-300 font-sans">
                    Huỷ
                  </button>
                )}
              </span>
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1.5">
              <div
                className={`h-full rounded-full ${j.status === "error" ? "bg-red-500" : "bg-indigo-500"}`}
                style={{ width: `${j.status === "done" ? 100 : pct}%` }}
              />
            </div>
            <div className="text-[10px] text-slate-500 mt-1 truncate">
              {j.status === "running" && j.current_file
                ? `Đang xử lý ${j.current_file} · `
                : ""}
              mới {j.processed} · bỏ qua {j.skipped}
              {j.failed ? ` · lỗi ${j.failed}` : ""}
              {j.error ? ` · ${j.error}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
};
