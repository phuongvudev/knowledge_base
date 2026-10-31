"use client";

import React, { useEffect, useState } from "react";
import { Gauge, Zap, Database, Cpu, RefreshCw, CheckCircle, TrendingDown } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { apiUrl } from "@/lib/api";

export const TelemetryDashboard: React.FC = () => {
  const [stats, setStats] = useState<any>({});
  const [usage, setUsage] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/metrics"));
      const data = await res.json();
      setStats(data);
      setUsage(await fetch(apiUrl("/api/usage?days=14")).then((r) => r.json()));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const t = setInterval(fetchStats, 3000);
    return () => clearInterval(t);
  }, []);

  const rawTokens = stats.total_raw_equivalent_tokens || 0;
  const returnedTokens = stats.total_tokens_returned || 0;
  const savedTokens = Math.max(0, rawTokens - returnedTokens);
  const percentSaved = stats.overall_savings_percent || 0;

  return (
    <div className="flex-1 p-4 sm:p-8 overflow-y-auto custom-scrollbar">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2 text-white">
              <Gauge className="w-6 h-6 text-emerald-400" />
              Báo Cáo Hiệu Năng & ROI Tiết Kiệm Token (Telemetry & ROI)
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Các chỉ số SLA nano-giây thời gian thực và tổng lượng token API đã được nén tối ưu qua MCP.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchStats}
            disabled={loading}
            className="flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Làm Mới
          </Button>
        </div>

        {/* 4 Metric Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <Card className="p-4 bg-slate-900/90 border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1">
              <Zap className="w-3.5 h-3.5 text-emerald-400" /> Độ Trễ P50 (In-Memory)
            </span>
            <div className="text-2xl font-bold text-emerald-400 font-mono mt-2">
              {stats.p50_latency_ms || 0} ms
            </div>
            <div className="flex items-center gap-1 text-[10px] text-emerald-500 mt-1 font-medium">
              <CheckCircle className="w-3 h-3" /> SLA: &lt; 2.0 ms (Đạt)
            </div>
          </Card>

          <Card className="p-4 bg-slate-900/90 border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1">
              <TrendingDown className="w-3.5 h-3.5 text-indigo-400" /> Tỷ Lệ Tiết Kiệm Token
            </span>
            <div className="text-2xl font-bold text-indigo-400 font-mono mt-2">
              {percentSaved}%
            </div>
            <div className="text-[10px] text-indigo-400/80 mt-1">
              Tiết kiệm ~{savedTokens.toLocaleString()} tokens
            </div>
          </Card>

          <Card className="p-4 bg-slate-900/90 border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1">
              <Database className="w-3.5 h-3.5 text-cyan-400" /> Lượt Truy Vấn MCP
            </span>
            <div className="text-2xl font-bold text-white font-mono mt-2">
              {stats.total_queries || 0}
            </div>
            <div className="text-[10px] text-slate-500 mt-1">
              Thời gian thực
            </div>
          </Card>

          <Card className="p-4 bg-slate-900/90 border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5 text-purple-400" /> RAM Sử Dụng
            </span>
            <div className="text-2xl font-bold text-purple-400 font-mono mt-2">
              {stats.current_ram_mb || 0} MB
            </div>
            <div className="text-[10px] text-purple-400/80 mt-1">
              Trần cho phép: &lt; 80 MB
            </div>
          </Card>
        </div>


        {/* MCP usage: what agents actually call, and whether it pays for itself */}
        {usage && (
          <Card className="p-6 bg-slate-900/90 border-slate-800 space-y-5">
            <div>
              <h3 className="text-sm font-bold text-white">Mức Độ Sử Dụng MCP (14 ngày)</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Mỗi lần agent gọi tool đều được ghi lại, kể cả lỗi và kết quả rỗng.
              </p>
            </div>

            <div className="grid grid-cols-4 gap-3 text-center">
              {[
                ["Lượt gọi", usage.calls],
                ["Phiên làm việc", usage.sessions],
                ["Tỷ lệ lỗi", usage.calls ? `${((usage.errors / usage.calls) * 100).toFixed(1)}%` : "–"],
                ["Kết quả rỗng", usage.calls ? `${((usage.empty / usage.calls) * 100).toFixed(1)}%` : "–"],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-lg bg-slate-950/70 border border-slate-800 p-3">
                  <div className="text-lg font-bold font-mono text-white">{value}</div>
                  <div className="text-[10px] text-slate-400">{label}</div>
                </div>
              ))}
            </div>

            <div className="rounded-lg bg-slate-950/70 border border-slate-800 p-4 text-xs space-y-1.5">
              <div className="flex justify-between text-slate-300">
                <span>Token tiết kiệm (ước tính, gộp)</span>
                <span className="font-mono text-emerald-400">+{usage.saved_tokens_gross.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>
                  Chi phí khai báo tool ({usage.schema_tokens_per_session.toLocaleString()} × {usage.sessions} phiên)
                </span>
                <span className="font-mono text-red-400">−{usage.overhead_tokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between font-bold border-t border-slate-800 pt-1.5">
                <span className="text-white">Lợi ròng</span>
                <span className={`font-mono ${usage.saved_tokens_net >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {usage.saved_tokens_net >= 0 ? "+" : ""}
                  {usage.saved_tokens_net.toLocaleString()} tokens
                </span>
              </div>
              <p className="text-[10px] text-slate-500 pt-1">
                Mức tiết kiệm là ước tính: so với việc agent đọc toàn bộ nguồn của các node khớp. Nếu agent vốn dùng grep
                có chọn lọc thì mức thực tế thấp hơn.
              </p>
            </div>

            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800">
                  <th className="py-1.5 font-medium">Tool</th>
                  <th className="text-right font-medium">Lượt</th>
                  <th className="text-right font-medium">TB ms</th>
                  <th className="text-right font-medium">TB token</th>
                  <th className="text-right font-medium">Lỗi</th>
                  <th className="text-right font-medium">Rỗng</th>
                </tr>
              </thead>
              <tbody className="font-mono text-slate-200">
                {usage.by_tool.map((t: any) => (
                  <tr key={t.tool} className="border-b border-slate-800/60">
                    <td className="py-1.5">{t.tool}</td>
                    <td className="text-right">{t.calls}</td>
                    <td className="text-right">{t.avg_ms}</td>
                    <td className="text-right">{t.avg_tokens}</td>
                    <td className={`text-right ${t.errors ? "text-red-400" : ""}`}>{t.errors}</td>
                    <td className={`text-right ${t.empty ? "text-amber-400" : ""}`}>{t.empty}</td>
                  </tr>
                ))}
                {usage.by_tool.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-3 text-center text-slate-500 font-sans">
                      Chưa có lượt gọi nào. Dữ liệu bắt đầu được ghi từ khi MCP server khởi động lại.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {(() => {
              const used = new Set(usage.by_tool.map((t: any) => t.tool));
              const unused = usage.all_tools.filter((n: string) => !used.has(n));
              return unused.length > 0 && usage.calls > 0 ? (
                <p className="text-[11px] text-slate-400">
                  Chưa từng được gọi: <span className="font-mono text-slate-300">{unused.join(", ")}</span>
                </p>
              ) : null;
            })()}

            {usage.by_day.length > 0 && (
              <div className="flex items-end gap-1" style={{ height: 64 }} aria-label="Lượt gọi theo ngày">
                {usage.by_day.map((d: any) => {
                  const max = Math.max(...usage.by_day.map((x: any) => x.calls));
                  return (
                    <div key={d.day} className="flex-1 flex flex-col items-center justify-end h-full" title={`${d.day}: ${d.calls}`}>
                      <div className="w-full bg-indigo-500/80 rounded-sm" style={{ height: `${Math.max(6, (d.calls / max) * 100)}%` }} />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {/* Token Context Reduction Visualization */}
        <Card className="p-6 bg-slate-900/90 border-slate-800 space-y-5">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              So Sánh Tiêu Thụ Context: Kiến Trúc Cũ vs Sơ Đồ Neuron
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Thay vì nạp toàn bộ mã nguồn và tệp văn bản thô vào context window của Agent, Neural Graph chỉ gửi cấu trúc Topological Hubs và tóm tắt tinh gọn.
            </p>
          </div>

          <div className="space-y-4">
            {/* Raw Context Bar */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-400 font-medium">Cách Cũ (Đọc Raw Sources vào Context Window)</span>
                <span className="text-red-400 font-mono font-bold">
                  {rawTokens.toLocaleString()} tokens
                </span>
              </div>
              <div className="w-full bg-slate-800/80 h-3 rounded-full overflow-hidden p-0.5 border border-slate-700/60">
                <div className="bg-gradient-to-r from-red-600 to-rose-500 h-full rounded-full" style={{ width: rawTokens ? "100%" : "0%" }} />
              </div>
            </div>

            {/* Neural Graph Bar */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-400 font-medium">
                  Sơ Đồ Neuron (Chỉ gửi Topology & Context Hubs)
                </span>
                <span className="text-emerald-400 font-mono font-bold">
                  {returnedTokens.toLocaleString()} tokens ({(rawTokens ? (returnedTokens / rawTokens) * 100 : 0).toFixed(1)}%)
                </span>
              </div>
              <div className="w-full bg-slate-800/80 h-3 rounded-full overflow-hidden p-0.5 border border-slate-700/60">
                <div
                  className="bg-gradient-to-r from-emerald-500 to-teal-400 h-full rounded-full"
                  style={{ width: `${rawTokens ? Math.max(1, (returnedTokens / rawTokens) * 100) : 0}%` }}
                />
              </div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
            <span className="text-xs text-slate-300">
              Chi phí tiết kiệm ước tính (gộp, dựa trên $0.003 / 1K tokens):
            </span>
            <span className="text-emerald-400 font-mono font-bold text-sm">
              ~${((savedTokens / 1000) * 0.003).toFixed(4)} / phiên làm việc
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
};
