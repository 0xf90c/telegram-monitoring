"use client";
import { useEffect, useMemo, useState, useCallback, useRef, useContext, createContext } from "react";
import axios from "axios";

const API = "http://127.0.0.1:8000";

// ─── Types ────────────────────────────────────────────────────────────────────
type Role = "admin" | "analytic" | "user";
type User = { username: string; role: Role };

type EventRow = {
  id: number; event_type: string; message_id: number;
  sender_name: string; sender_username: string | null;
  text: string | null; old_text: string | null; new_text: string | null;
  media_type: string | null; media_path: string | null;
  deleted_ids: number[] | null; missing_ids: number[] | null;
  deleted_original_text: string | null; deleted_original_media_type: string | null;
  deleted_original_media_path: string | null; deleted_original_sender_name: string | null;
  deleted_original_sender_username: string | null;
  telegram_link: string | null; severity: string; created_at: string;
  is_forwarded: boolean; forward_from_name: string | null;
  forward_from_chat_id: string | null; forward_from_chat_title: string | null;
  keyword_alerts?: string[];
};
type Group = { chat_id: string; chat_title: string; total: number; edited: number; deleted: number; missing: number };
type DaySummary = { date: string; total: number; edited: number; deleted: number; missing: number };
type HourlyData = { hour: string; new_message: number; edited_message: number; deleted_message: number; missing_ids: number };
type WeeklyTrend = { date: string; total: number; deleted: number; edited: number; missing: number };
type EventDist = { event_type: string; count: number };
type TopGroup = { chat_id: string; chat_title: string; total: number; deleted: number; edited: number; delete_rate: number };
type TopSender = { sender_id: string; sender_name: string; sender_username: string | null; total: number; deleted: number; edited: number };
type DeletedFeedEvent = {
  id: number;
  message_id: number;
  chat_id: string;
  chat_title: string;
  deleted_at: string;
  deleted_by_name: string | null;
  deleted_by_username: string | null;
  original_text: string | null;
  original_sender_name: string | null;
  original_sender_username: string | null;
  original_media_type: string | null;
  original_media_path: string | null;
  original_created_at: string | null;
  time_to_delete: number | null;
  speed_label: string;
  telegram_link: string | null;
  keyword_alerts: string[];
};

type DeletedFeedStats = {
  quick_deletes: number;
  fast_deletes: number;
  with_text: number;
  with_media: number;
  no_info: number;
};

type TimelineEvent = { id: number; event_type: string; message_id: number; sender_name: string; sender_username: string | null; text: string | null; old_text: string | null; new_text: string | null; media_type: string | null; media_path: string | null; severity: string; created_at: string; time_label: string; telegram_link: string | null; keyword_alerts: string[]; is_forwarded: boolean; forward_from_chat_title: string | null };

// ─── Toast notification system ──────────────────────────────────────────────
type ToastType = "error" | "warning" | "success" | "info";
type Toast = { id: number; message: string; type: ToastType };

type ToastContextValue = { addToast: (message: string, type?: ToastType) => void };
const ToastContext = createContext<ToastContextValue>({ addToast: () => {} });

function useToast() { return useContext(ToastContext); }

let _toastId = 0;

function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: ToastType = "error") => {
    const id = ++_toastId;
    setToasts(prev => [...prev.slice(-4), { id, message, type }]); // max 5 toast
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const typeStyles: Record<ToastType, string> = {
    error:   "border-rose-700/60 bg-rose-950/80 text-rose-300",
    warning: "border-amber-700/60 bg-amber-950/80 text-amber-300",
    success: "border-emerald-700/60 bg-emerald-950/80 text-emerald-300",
    info:    "border-sky-700/60 bg-sky-950/80 text-sky-300",
  };
  const typeIcons: Record<ToastType, string> = {
    error: "✕", warning: "⚠", success: "✓", info: "ℹ",
  };

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast container — fixed, top-right */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none" style={{ maxWidth: "360px" }}>
        {toasts.map(t => (
          <div key={t.id}
            className={`flex items-start gap-3 px-4 py-3 rounded-xl border font-mono text-xs backdrop-blur-sm
              pointer-events-auto shadow-lg transition-all duration-300 animate-slideIn ${typeStyles[t.type]}`}>
            <span className="text-sm shrink-0 mt-0.5">{typeIcons[t.type]}</span>
            <span className="flex-1 leading-relaxed">{t.message}</span>
            <button
              onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
              className="shrink-0 opacity-60 hover:opacity-100 transition-opacity ml-1">✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ─── JWT Token storage ────────────────────────────────────────────────────────
const TOKEN_KEY = "tg_monitor_token";
const TOKEN_EXP  = "tg_monitor_exp";

function saveToken(token: string, expiresIn: number) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TOKEN_EXP, String(Date.now() + expiresIn * 1000));
}
function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_EXP); }
function getTokenExpiry(): number { return parseInt(localStorage.getItem(TOKEN_EXP) || "0", 10); }

// ─── Axios instance — token interceptor bilan ─────────────────────────────────
const apiClient = axios.create({ baseURL: API });

apiClient.interceptors.request.use(cfg => {
  const token = getToken();
  if (token && cfg.headers) cfg.headers["Authorization"] = "Bearer " + token;
  return cfg;
});

apiClient.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) { clearToken(); window.location.reload(); }
    return Promise.reject(err);
  }
);

type Api = typeof apiClient;

async function loginWithCredentials(username: string, password: string): Promise<{ user: User; api: Api }> {
  const form = new URLSearchParams();
  form.append("username", username);
  form.append("password", password);
  const res = await axios.post(API + "/auth/login", form, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const { access_token, expires_in, role, username: uname } = res.data;
  saveToken(access_token, expires_in);
  return { user: { username: uname, role: role as Role }, api: apiClient };
}

function useTokenRefresh(isLoggedIn: boolean, onExpired: () => void) {
  useEffect(() => {
    if (!isLoggedIn) return;
    const iv = setInterval(async () => {
      const remaining = getTokenExpiry() - Date.now();
      if (remaining <= 0) { clearToken(); onExpired(); return; }
      if (remaining < 5 * 60 * 1000) {
        try {
          const res = await apiClient.post("/auth/refresh");
          const { access_token, expires_in } = res.data;
          saveToken(access_token, expires_in);
        } catch { clearToken(); onExpired(); }
      }
    }, 60_000);
    return () => clearInterval(iv);
  }, [isLoggedIn, onExpired]);
}

function restoreSession(): { user: User; api: Api } | null {
  const token = getToken();
  if (!token || Date.now() > getTokenExpiry()) { clearToken(); return null; }
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return { user: { username: payload.sub, role: payload.role as Role }, api: apiClient };
  } catch { clearToken(); return null; }
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function buildMonthDays(sel: string, days: string[]) {
  const base = sel ? new Date(sel) : new Date();
  const year = base.getFullYear(), month = base.getMonth();
  const firstWD = new Date(year, month, 1).getDay();
  const last = new Date(year, month + 1, 0).getDate();
  const set = new Set(days);
  return [
    ...Array.from({ length: firstWD }, () => ({ day: 0, date: "", hasLogs: false, blank: true })),
    ...Array.from({ length: last }, (_, i) => {
      const day = i + 1;
      const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return { day, date, hasLogs: set.has(date), blank: false };
    }),
  ];
}
function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function timeStr(ts: string) { return ts?.slice(11, 16) || "—"; }

// ─── Small atoms ──────────────────────────────────────────────────────────────
function Badge({ type }: { type: string }) {
  const s: Record<string, {bg:string;color:string;border:string}> = {
    new_message:     {bg:"rgba(0,255,136,0.08)",  color:"var(--neon-green)",  border:"rgba(0,255,136,0.4)"},
    edited_message:  {bg:"rgba(255,170,0,0.08)",  color:"var(--neon-amber)",  border:"rgba(255,170,0,0.4)"},
    deleted_message: {bg:"rgba(255,51,102,0.08)", color:"var(--neon-red)",    border:"rgba(255,51,102,0.4)"},
    missing_ids:     {bg:"rgba(176,96,255,0.08)", color:"var(--neon-purple)", border:"rgba(176,96,255,0.4)"},
  };
  const labels: Record<string,string> = {new_message:"NEW",edited_message:"EDITED",deleted_message:"DELETED",missing_ids:"MISSING"};
  const st = s[type] || {bg:"rgba(0,200,255,0.05)",color:"rgba(0,200,255,0.6)",border:"rgba(0,200,255,0.25)"};
  return (
    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded tracking-widest"
      style={{background:st.bg,color:st.color,border:`1px solid ${st.border}`,textShadow:`0 0 6px ${st.color}`}}>
      {labels[type] || type.toUpperCase()}
    </span>
  );
}

function RoleBadge({ role }: { role: Role }) {
  const s: Record<Role,{bg:string;color:string;border:string}> = {
    admin:    {bg:"rgba(255,51,102,0.08)",  color:"var(--neon-red)",    border:"rgba(255,51,102,0.4)"},
    analytic: {bg:"rgba(176,96,255,0.08)", color:"var(--neon-purple)", border:"rgba(176,96,255,0.4)"},
    user:     {bg:"rgba(0,200,255,0.06)",  color:"var(--neon-blue)",   border:"rgba(0,200,255,0.3)"},
  };
  const st = s[role];
  return (
    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded tracking-widest"
      style={{background:st.bg,color:st.color,border:`1px solid ${st.border}`,textShadow:`0 0 6px ${st.color}`}}>
      {role.toUpperCase()}
    </span>
  );
}

function StatCard({ label, value, sub, accent = "border-[rgba(0,200,255,0.15)]" }: { label: string; value: number | string; sub?: string; accent?: string }) {
  return (
    <div className={`rounded-xl border ${accent} bg-[#0a0a1c] px-5 py-4`}>
      <div className="text-[10px] font-mono tracking-widest text-[rgba(0,200,255,0.45)] mb-1">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] font-mono text-[rgba(0,200,255,0.3)] mt-1">{sub}</div>}
    </div>
  );
}

function Pill({ label, color = "zinc" }: { label: string; color?: string }) {
  const colorMap: Record<string, string> = {
    red: "bg-rose-500/20 text-rose-300", amber: "bg-amber-500/20 text-amber-300",
    green: "bg-emerald-500/20 text-emerald-300", blue: "bg-sky-500/20 text-sky-300",
    zinc: "bg-[rgba(0,200,255,0.08)]/50 text-[rgba(255,255,255,0.75)]", purple: "bg-purple-500/20 text-purple-300",
  };
  return <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${colorMap[color] || colorMap.zinc}`}>{label}</span>;
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="text-xs font-mono tracking-[0.2em] text-[rgba(0,200,255,0.45)] uppercase">{title}</div>
      {count !== undefined && <div className="text-[10px] font-mono text-[rgba(0,200,255,0.3)] bg-[rgba(0,200,255,0.06)] px-2 py-0.5 rounded">{count}</div>}
      <div className="flex-1 h-px" style={{background:"linear-gradient(90deg,rgba(0,200,255,0.2),transparent)"}} />
    </div>
  );
}

function Loader() {
  return <div className="flex items-center justify-center py-24 text-[rgba(0,200,255,0.3)] font-mono text-sm tracking-widest animate-pulse">LOADING...</div>;
}

function Empty({ text = "No data" }: { text?: string }) {
  return <div className="text-center py-16 text-[rgba(0,200,255,0.2)] font-mono text-sm">{text}</div>;
}

// ─── Diff View ────────────────────────────────────────────────────────────────
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <div className="rounded-lg border border-[rgba(0,200,255,0.1)] overflow-hidden text-xs font-mono">
      {oldText && (
        <div className="px-3 py-2 bg-rose-950/30 border-b border-[rgba(0,200,255,0.1)]">
          <span className="text-rose-400 mr-2 select-none">−</span>
          <span className="text-rose-300">{oldText}</span>
        </div>
      )}
      {newText && (
        <div className="px-3 py-2 bg-emerald-950/30">
          <span className="text-emerald-400 mr-2 select-none">+</span>
          <span className="text-emerald-300">{newText}</span>
        </div>
      )}
    </div>
  );
}

// ─── Bar ──────────────────────────────────────────────────────────────────────
function BarRow({ label, value, max, color = "#38bdf8", right }: { label: string; value: number; max: number; color?: string; right?: React.ReactNode }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="w-32 shrink-0 text-xs font-mono text-[rgba(255,255,255,0.55)] truncate">{label}</div>
      <div className="flex-1 h-1.5 bg-[rgba(0,200,255,0.06)] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <div className="shrink-0 text-xs font-mono text-[rgba(255,255,255,0.55)] tabular-nums w-10 text-right">{value}</div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

// ─── Hourly Heatmap ───────────────────────────────────────────────────────────
function HourlyHeatmap({ data }: { data: HourlyData[] }) {
  if (!data.length) return <Empty />;
  const types = ["new_message", "deleted_message", "edited_message"] as const;
  const colors: Record<string, string> = { new_message: "#34d399", deleted_message: "#f87171", edited_message: "#fbbf24" };
  const labels: Record<string, string> = { new_message: "NEW", deleted_message: "DEL", edited_message: "EDT" };
  const maxVal = Math.max(...data.flatMap(d => types.map(t => d[t])), 1);
  const cellW = 100 / data.length;
  const cellH = 14;
  const totalH = types.length * cellH + 20;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 100 ${totalH}`} className="w-full min-w-[500px]" preserveAspectRatio="none">
        {data.filter((_, i) => i % 4 === 0).map((d, idx) => {
          const ri = data.findIndex(x => x.hour === d.hour);
          return <text key={idx} x={ri * cellW + cellW / 2} y={totalH - 2} textAnchor="middle" fontSize="3" fill="#52525b" fontFamily="monospace">{d.hour.slice(0, 2)}</text>;
        })}
        {types.map((type, rowIdx) =>
          data.map((d, colIdx) => {
            const val = d[type];
            const opacity = val === 0 ? 0.06 : 0.15 + (val / maxVal) * 0.85;
            return <rect key={`${rowIdx}-${colIdx}`} x={colIdx * cellW + 0.2} y={rowIdx * cellH + 2} width={cellW - 0.4} height={cellH - 1} fill={colors[type]} opacity={opacity} rx={0.5} />;
          })
        )}
        {types.map((type, rowIdx) => (
          <text key={type} x={-1} y={rowIdx * cellH + cellH / 2 + 3} textAnchor="end" fontSize="3" fill={colors[type]} fontFamily="monospace">{labels[type]}</text>
        ))}
      </svg>
      <div className="flex gap-4 mt-2 justify-end">
        {types.map(t => (
          <div key={t} className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: colors[t] }} />
            <span className="text-[10px] font-mono text-[rgba(0,200,255,0.45)]">{labels[t]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Weekly Sparkline ─────────────────────────────────────────────────────────
function WeeklySparkline({ data }: { data: WeeklyTrend[] }) {
  if (!data.length) return <Empty />;
  const maxV = Math.max(...data.map(d => d.total), 1);
  const H = 60, W = 100;
  const pts = data.map((d, i) => `${(i / Math.max(data.length - 1, 1)) * W},${H - (d.total / maxV) * (H - 8) - 2}`);
  const delPts = data.map((d, i) => `${(i / Math.max(data.length - 1, 1)) * W},${H - (d.deleted / maxV) * (H - 8) - 2}`);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        <polyline points={pts.join(" ")} fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={delPts.join(" ")} fill="none" stroke="#f87171" strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="2,1" />
        {data.map((d, i) => {
          const x = (i / Math.max(data.length - 1, 1)) * W;
          const y = H - (d.total / maxV) * (H - 8) - 2;
          return <circle key={i} cx={x} cy={y} r="1.5" fill="#38bdf8" />;
        })}
      </svg>
      <div className="flex mt-1">
        {data.map(d => <div key={d.date} className="flex-1 text-center text-[9px] font-mono text-[rgba(0,200,255,0.3)] truncate">{d.date?.slice(5)}</div>)}
      </div>
    </div>
  );
}

// ─── Node Graph (clusters) ────────────────────────────────────────────────────
function NodeGraph({ nodes, edges }: { nodes: string[]; edges: { source: string; target: string; weight: number }[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    if (!nodes.length) return;
    const W = 600, H = 400;
    const pos: Record<string, { x: number; y: number }> = {};
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      pos[n] = { x: W / 2 + Math.cos(angle) * 180, y: H / 2 + Math.sin(angle) * 160 };
    });

    // Simple force iterations
    for (let iter = 0; iter < 50; iter++) {
      // Repulsion
      nodes.forEach(a => nodes.forEach(b => {
        if (a === b) return;
        const dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = 800 / (dist * dist);
        pos[a].x += dx / dist * force;
        pos[a].y += dy / dist * force;
      }));
      // Attraction along edges
      edges.forEach(({ source, target, weight }) => {
        if (!pos[source] || !pos[target]) return;
        const dx = pos[target].x - pos[source].x, dy = pos[target].y - pos[source].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - 100) * 0.05 * Math.min(weight, 5);
        pos[source].x += dx / dist * force;
        pos[source].y += dy / dist * force;
        pos[target].x -= dx / dist * force;
        pos[target].y -= dy / dist * force;
      });
      // Clamp
      nodes.forEach(n => {
        pos[n].x = Math.max(30, Math.min(W - 30, pos[n].x));
        pos[n].y = Math.max(20, Math.min(H - 20, pos[n].y));
      });
    }
    setPositions(pos);
  }, [nodes, edges]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !Object.keys(positions).length) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const maxW = Math.max(...edges.map(e => e.weight), 1);
    edges.forEach(({ source, target, weight }) => {
      const a = positions[source], b = positions[target];
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(56,189,248,${0.1 + (weight / maxW) * 0.5})`;
      ctx.lineWidth = 0.5 + (weight / maxW) * 2;
      ctx.stroke();
    });

    nodes.forEach(n => {
      const p = positions[n];
      if (!p) return;
      const edgeDeg = edges.filter(e => e.source === n || e.target === n).length;
      const radius = 4 + edgeDeg * 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = edgeDeg > 3 ? "#f87171" : "#38bdf8";
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      ctx.fillText(n.slice(0, 12), p.x, p.y - radius - 3);
    });
  }, [positions, nodes, edges]);

  if (!nodes.length) return <Empty text="No conversation data" />;

  return (
    <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#04040a] overflow-hidden">
      <canvas ref={canvasRef} width={600} height={400} className="w-full" />
      <div className="flex items-center gap-4 px-4 py-2 border-t border-[rgba(0,200,255,0.1)]">
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-sky-400" /><span className="text-[10px] font-mono text-[rgba(0,200,255,0.45)]">User</span></div>
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-rose-400" /><span className="text-[10px] font-mono text-[rgba(0,200,255,0.45)]">High activity</span></div>
        <div className="flex-1 text-right text-[10px] font-mono text-[rgba(0,200,255,0.3)]">{nodes.length} nodes · {edges.length} edges</div>
      </div>
    </div>
  );
}

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
function LoginPage({ onLogin }: { onLogin: (u: User, api: Api) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) { setError("Ikkala maydonni to'ldiring"); return; }
    setLoading(true); setError("");
    try {
      const { user, api } = await loginWithCredentials(username, password);
      onLogin(user, api);
    } catch (err: any) {
      const msg = err?.response?.data?.detail || "Login yoki parol noto'g'ri";
      setError(msg);
    } finally { setLoading(false); }
  };

  return (
    <main className="min-h-screen bg-[#04040a] text-white flex items-center justify-center relative" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');`}</style>
      <div className="w-full max-w-sm p-8 rounded-2xl bg-[#06060f] space-y-6 glow-green relative" style={{border:"1px solid rgba(0,255,136,0.3)"}}>
        <div>
          <div className="flex items-center gap-2 mb-5">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[10px] tracking-[0.25em] text-[rgba(0,200,255,0.45)]">TELEGRAM MONITOR</span>
          </div>
          <h1 className="text-2xl font-bold text-glow-green" style={{color:"var(--neon-green)"}}>Sign In</h1>
          <p className="text-xs text-[rgba(0,200,255,0.3)] mt-1">Monitoring dashboard'ga kirish</p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] tracking-widest text-[rgba(0,200,255,0.3)] block mb-1">USERNAME</label>
            <input value={username} onChange={e => setUsername(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()}
              className="w-full rounded-lg px-4 py-3 text-sm font-mono outline-none transition-all neon-input neon-input-green" style={{background:"rgba(0,255,136,0.03)",border:"1px solid rgba(0,255,136,0.2)",color:"var(--neon-green)"}} />
          </div>
          <div>
            <label className="text-[10px] tracking-widest text-[rgba(0,200,255,0.3)] block mb-1">PASSWORD</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()}
              className="w-full rounded-lg px-4 py-3 text-sm font-mono outline-none transition-all neon-input neon-input-green" style={{background:"rgba(0,255,136,0.03)",border:"1px solid rgba(0,255,136,0.2)",color:"var(--neon-green)"}} />
          </div>
        </div>
        {error && <div className="rounded-lg border border-rose-800/50 bg-rose-950/20 px-4 py-3 text-sm font-mono text-rose-400">{error}</div>}
        <button onClick={handleLogin} disabled={loading}
          className="w-full py-3 rounded-lg disabled:opacity-40 transition-all text-sm font-bold tracking-widest btn-neon-blue" style={{background:"rgba(0,200,255,0.08)",border:"1px solid rgba(0,200,255,0.4)",color:"var(--neon-blue)"}}>
          {loading ? "CHECKING..." : "LOGIN →"}
        </button>
        <div className="border-t border-[rgba(0,200,255,0.1)] pt-4 space-y-1 text-[10px] font-mono text-[rgba(0,200,255,0.2)]">
          <div>admin → barcha funksiyalar</div>
          <div>analytic → statistika + monitoring</div>
          <div>user → faqat ruxsat berilgan chatlar</div>
        </div>
      </div>
    </main>
  );
}


// ─── Telegram Bubble Components ──────────────────────────────────────────────

// Sender nomidan deterministik rang
function avatarColor(name: string): string {
  const colors = [
    "linear-gradient(135deg,#1a3a5c,#4fafe3)",
    "linear-gradient(135deg,#1a3a2a,#00ff88)",
    "linear-gradient(135deg,#3a1a3a,#b060ff)",
    "linear-gradient(135deg,#3a1a1a,#ff3366)",
    "linear-gradient(135deg,#3a2a00,#ffaa00)",
    "linear-gradient(135deg,#003a3a,#00ffe5)",
    "linear-gradient(135deg,#1a2a3a,#38bdf8)",
    "linear-gradient(135deg,#2a1a3a,#e879f9)",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function senderColor(name: string): string {
  const colors = ["#4fafe3","#00ff88","#b060ff","#ff3366","#ffaa00","#00ffe5","#38bdf8","#e879f9"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// Keyword highlight helper
function HighlightedText({ text, keywords }: { text: string; keywords?: string[] }) {
  if (!text) return null;
  if (!keywords?.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi"));
  return (
    <>
      {parts.map((p, i) => {
        const isMatch = keywords.some(k => k.toLowerCase() === p.toLowerCase());
        return isMatch ? <mark key={i} className="tg-kw-mark">{p}</mark> : <span key={i}>{p}</span>;
      })}
    </>
  );
}

// Media renderer inside bubble
function TgMedia({ mediaPath, mediaType, API_BASE }: { mediaPath?: string | null; mediaType?: string | null; API_BASE: string }) {
  if (!mediaPath || !mediaType || mediaType === "pending") return null;
  const url = `${API_BASE}/${mediaPath.replaceAll("\\", "/")}`;

  if (["photo","image"].includes(mediaType)) {
    return <div className="tg-media"><img src={url} alt="photo" loading="lazy" /></div>;
  }
  if (mediaType === "gif") {
    return <div className="tg-media"><video src={url} autoPlay loop muted /></div>;
  }
  if (mediaType === "video") {
    return <div className="tg-media"><video src={url} controls /></div>;
  }
  if (["sticker","animated_sticker","video_sticker"].includes(mediaType)) {
    return (
      <div style={{width:120,height:120,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:4}}>
        <img src={url} style={{maxWidth:120,maxHeight:120,objectFit:"contain"}} />
      </div>
    );
  }
  if (["voice","audio"].includes(mediaType)) {
    return (
      <div className="tg-voice" style={{marginBottom:4}}>
        <div className="tg-voice-icon">🎙</div>
        <div className="tg-voice-bar" />
        <audio src={url} controls style={{display:"none"}} />
      </div>
    );
  }
  return (
    <div className="tg-media-placeholder">
      <span style={{fontSize:24}}>📎</span>
      <span>{mediaType.toUpperCase()}</span>
    </div>
  );
}

// Main TelegramBubble component
interface TgBubbleProps {
  event: EventRow;
  apiBase: string;
  onClick?: () => void;
  compact?: boolean; // EventCard ichida kichik versiya
}

function TelegramBubble({ event: e, apiBase, onClick, compact = false }: TgBubbleProps) {
  const senderName = e.sender_name || e.deleted_original_sender_name || "Unknown";
  const senderUsername = e.sender_username || e.deleted_original_sender_username;
  const avatarLetter = senderName[0]?.toUpperCase() || "?";
  const aColor = avatarColor(senderName);
  const sColor = senderColor(senderName);
  const timeLabel = e.created_at ? e.created_at.slice(11, 16) : "—";
  const keywords = e.keyword_alerts || [];

  const mediaPath = e.media_path;
  const mediaType = e.media_type && e.media_type !== "pending" ? e.media_type : null;

  // ── MISSING IDs — system message ──────────────────────────────────────────
  if (e.event_type === "missing_ids") {
    return (
      <div className="tg-system">
        ⚠ {e.missing_ids?.length || 0} ta xabar tushib qoldi
        {e.missing_ids?.length ? ` (ID: ${e.missing_ids[0]}${e.missing_ids.length > 1 ? "–" + e.missing_ids[e.missing_ids.length-1] : ""})` : ""}
      </div>
    );
  }

  // ── DELETED — original bubble with overlay ────────────────────────────────
  if (e.event_type === "deleted_message") {
    const origText = e.deleted_original_text || e.text;
    const origMediaType = e.deleted_original_media_type;
    const origMediaPath = e.deleted_original_media_path;
    const origSender = e.deleted_original_sender_name || senderName;
    const origUsername = e.deleted_original_sender_username || senderUsername;
    const origColor = senderColor(origSender);

    return (
      <div className="tg-row" onClick={onClick} style={onClick ? {cursor:"pointer"} : {}}>
        <div className="tg-avatar" style={{background: avatarColor(origSender)}}>
          {origSender[0]?.toUpperCase() || "?"}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:2}}>
          {/* Event badge */}
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
            <span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:12,background:"rgba(255,51,102,0.12)",color:"var(--neon-red)",border:"1px solid rgba(255,51,102,0.3)"}}>✕ DELETED</span>
            {keywords.map(kw => <span key={kw} style={{fontSize:10,fontFamily:"monospace",padding:"2px 6px",borderRadius:12,background:"rgba(255,51,102,0.1)",color:"var(--neon-red)"}}>{kw}</span>)}
          </div>
          <div className="tg-bubble tg-in tg-deleted">
            <div className="tg-sender" style={{color: origColor}}>
              {origSender}{origUsername ? <span style={{fontWeight:400,opacity:0.6}}> @{origUsername}</span> : ""}
            </div>
            {/* Original media if any */}
            {origMediaPath && origMediaType && (
              <TgMedia mediaPath={origMediaPath} mediaType={origMediaType} API_BASE={apiBase} />
            )}
            {origText ? (
              <div className="tg-deleted-text tg-text">
                <HighlightedText text={origText} keywords={keywords} />
              </div>
            ) : (
              <div className="tg-deleted-text tg-text" style={{fontStyle:"italic",opacity:0.5}}>
                {origMediaType ? `[${origMediaType.toUpperCase()}]` : "[matn yo'q]"}
              </div>
            )}
            <div className="tg-meta">
              <span className="tg-time">{timeLabel}</span>
              <span style={{fontSize:11,color:"var(--neon-red)"}}>🗑</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── EDITED — two bubbles (before + after) ─────────────────────────────────
  if (e.event_type === "edited_message") {
    return (
      <div style={{display:"flex",flexDirection:"column",gap:3}} onClick={onClick} style_cursor={onClick ? "pointer" : undefined}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
          <span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:12,background:"rgba(255,170,0,0.12)",color:"var(--neon-amber)",border:"1px solid rgba(255,170,0,0.3)"}}>✎ EDITED</span>
        </div>
        <div className="tg-row">
          <div className="tg-avatar" style={{background: aColor}}>{avatarLetter}</div>
          <div style={{display:"flex",flexDirection:"column",gap:3}}>
            {/* Old bubble */}
            {e.old_text && (
              <div className="tg-bubble tg-in" style={{background:"rgba(30,20,25,0.95)",borderColor:"rgba(255,51,102,0.2)",border:"1px solid rgba(255,51,102,0.2)"}}>
                <div className="tg-sender" style={{color: sColor}}>{senderName}</div>
                <div className="tg-diff-label">− ORIGINAL</div>
                <div className="tg-diff-old">{e.old_text}</div>
                <div className="tg-meta"><span className="tg-time">{timeLabel}</span></div>
              </div>
            )}
            {/* New bubble */}
            {e.new_text && (
              <div className="tg-bubble tg-in" style={{marginLeft: e.old_text ? 0 : 0}}>
                {!e.old_text && <div className="tg-sender" style={{color: sColor}}>{senderName}</div>}
                <div className="tg-diff-label">+ EDITED</div>
                <div className="tg-diff-new">
                  <HighlightedText text={e.new_text} keywords={keywords} />
                </div>
                <div className="tg-meta">
                  <span className="tg-time">{timeLabel}</span>
                  <span className="tg-edited-mark">✎</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── NEW MESSAGE ───────────────────────────────────────────────────────────
  const isSticker = mediaType && ["sticker","animated_sticker","video_sticker"].includes(mediaType);

  return (
    <div className="tg-row" onClick={onClick} style={onClick ? {cursor:"pointer"} : {}}>
      <div className="tg-avatar" style={{background: aColor}}>{avatarLetter}</div>
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        {/* Badge row */}
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
          <span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:12,background:"rgba(0,255,136,0.08)",color:"var(--neon-green)",border:"1px solid rgba(0,255,136,0.25)"}}>● NEW</span>
          {e.is_forwarded && <span style={{fontSize:10,fontFamily:"monospace",padding:"2px 6px",borderRadius:12,background:"rgba(0,200,255,0.08)",color:"var(--neon-blue)",border:"1px solid rgba(0,200,255,0.25)"}}>FWD</span>}
          {keywords.map(kw => <span key={kw} style={{fontSize:10,fontFamily:"monospace",padding:"2px 6px",borderRadius:12,background:"rgba(255,51,102,0.1)",color:"var(--neon-red)"}}>{kw.toUpperCase()}</span>)}
        </div>
        <div className={`tg-bubble tg-in${isSticker ? " tg-sticker" : ""}`}>
          <div className="tg-sender" style={{color: sColor}}>
            {senderName}
            {senderUsername && <span style={{fontWeight:400,opacity:0.55,fontSize:12}}> @{senderUsername}</span>}
          </div>
          {/* Forwarded bar */}
          {e.is_forwarded && (
            <div className="tg-fwd">
              Forwarded from <span className="tg-fwd-from">
                {e.forward_from_chat_title || e.forward_from_name || "Unknown"}
              </span>
            </div>
          )}
          {/* Media */}
          {mediaPath && mediaType && (
            <TgMedia mediaPath={mediaPath} mediaType={mediaType} API_BASE={apiBase} />
          )}
          {/* Text */}
          {e.text && !isSticker && (
            <div className="tg-text">
              <HighlightedText text={e.text} keywords={keywords} />
            </div>
          )}
          {!e.text && !mediaPath && <div className="tg-text" style={{fontStyle:"italic",opacity:0.4}}>[bo'sh xabar]</div>}
          {/* Meta */}
          <div className="tg-meta">
            <span className="tg-time">{timeLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── OVERVIEW sub-components ──────────────────────────────────────────────────
function GroupCard({ group, onClick }: { group: Group; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="w-full text-left rounded-xl transition-all p-5 space-y-4 group" style={{background:"rgba(8,8,24,0.95)",border:"1px solid rgba(0,200,255,0.1)"}} onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.border="1px solid rgba(0,200,255,0.35)";(e.currentTarget as HTMLElement).style.boxShadow="0 0 16px rgba(0,200,255,0.12)"}} onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.border="1px solid rgba(0,200,255,0.1)";(e.currentTarget as HTMLElement).style.boxShadow="none"}}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-[rgba(0,200,255,0.06)] flex items-center justify-center text-sm font-bold border border-[rgba(0,200,255,0.15)] uppercase">
          {(group.chat_title || "?")[0]}
        </div>
        <h3 className="font-semibold text-sm leading-tight line-clamp-2 flex-1">{group.chat_title || "Unknown"}</h3>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 py-2">
          <div className="text-base font-bold text-emerald-400">{group.total}</div>
          <div className="text-[10px] text-[rgba(0,200,255,0.3)] font-mono">TOTAL</div>
        </div>
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 py-2">
          <div className="text-base font-bold text-amber-400">{group.edited}</div>
          <div className="text-[10px] text-[rgba(0,200,255,0.3)] font-mono">EDITED</div>
        </div>
        <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 py-2">
          <div className="text-base font-bold text-rose-400">{group.deleted}</div>
          <div className="text-[10px] text-[rgba(0,200,255,0.3)] font-mono">DELETED</div>
        </div>
      </div>
    </button>
  );
}

function EventCard({ event, onClick }: { event: EventRow; onClick: () => void }) {
  const preview = event.deleted_original_text || event.new_text || event.text || event.old_text
    || (event.media_type ? `[${event.media_type.toUpperCase()}]` : null)
    || (event.deleted_ids ? `Deleted IDs: ${event.deleted_ids.join(", ")}` : "—");
  return (
    <button onClick={onClick}
      className="w-full text-left rounded-xl transition-all p-4 space-y-3" style={{background:"rgba(8,8,24,0.95)",border:"1px solid rgba(0,200,255,0.08)"}} onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.border="1px solid rgba(0,200,255,0.3)";(e.currentTarget as HTMLElement).style.boxShadow="0 0 12px rgba(0,200,255,0.1)"}} onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.border="1px solid rgba(0,200,255,0.08)";(e.currentTarget as HTMLElement).style.boxShadow="none"}}>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge type={event.event_type} />
        {event.is_forwarded && <Pill label="FWD" color="blue" />}
        {event.keyword_alerts?.map(kw => <Pill key={kw} label={kw.toUpperCase()} color="red" />)}
        <span className="text-xs font-mono text-[rgba(0,200,255,0.45)] ml-auto">{timeStr(event.created_at)}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-[rgba(0,200,255,0.08)] flex items-center justify-center text-[10px] font-bold uppercase shrink-0">
          {(event.sender_name || "?")[0]}
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold truncate">{event.sender_name || "Unknown"}</div>
          {event.sender_username && <div className="text-[10px] text-sky-400 font-mono">@{event.sender_username}</div>}
        </div>
      </div>
      <p className="text-xs text-[rgba(255,255,255,0.55)] line-clamp-2 font-mono">{preview}</p>
    </button>
  );
}

// ─── LookupButton — ma'lumot yo'q xabarlar uchun DB dan qidirish ──────────────
function LookupButton({
  api, chatId, messageId, onFound,
}: {
  api: Api;
  chatId: string;
  messageId: number;
  onFound: (data: any) => void;
}) {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const lookup = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/message-lookup?chat_id=${chatId}&message_id=${messageId}`);
      const data = r.data;
      setResult(data);
      if (data.source !== "not_found") {
        onFound(data);
        addToast(`Topildi: ${data.source === "cache" ? "cache" : "DB"}`, "success");
      } else {
        addToast("Xabar topilmadi — juda eski yoki kesh yo'q", "warning");
      }
    } catch {
      addToast("Qidirishda xato", "error");
    } finally {
      setLoading(false);
    }
  };

  if (result?.source === "not_found") {
    return (
      <span className="text-[11px] font-mono italic" style={{color:"rgba(255,255,255,0.2)"}}>
        Topilmadi — eski xabar
      </span>
    );
  }

  return (
    <button onClick={e => { e.stopPropagation(); lookup(); }} disabled={loading}
      className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1 rounded-lg transition-all disabled:opacity-50"
      style={{background:"rgba(0,200,255,0.06)",border:"1px solid rgba(0,200,255,0.2)",color:"rgba(0,200,255,0.7)"}}>
      {loading ? (
        <span className="animate-neonPulse">⟳ Qidirilmoqda...</span>
      ) : (
        <>🔍 DB dan qidirish</>
      )}
    </button>
  );
}


// ─── Deleted Feed Tab ────────────────────────────────────────────────────────
function DeletedFeedTab({ date, api, groups }: { date: string; api: Api; groups: Group[] }) {
  const { addToast } = useToast();
  const [data, setData] = useState<{ total: number; stats: DeletedFeedStats; events: DeletedFeedEvent[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [speed, setSpeed] = useState("");
  const [chatFilter, setChatFilter] = useState("");
  const [sender, setSender] = useState("");
  const [selected, setSelected] = useState<DeletedFeedEvent | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ date });
    if (speed)      params.append("speed", speed);
    if (chatFilter) params.append("chat_id", chatFilter);
    if (sender)     params.append("sender", sender);
    api.get(`/deleted-feed?${params}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || "Deleted feed yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, speed, chatFilter, sender]);

  useEffect(() => { load(); }, [load]);

  // Speed color
  const speedColor = (ttd: number | null) => {
    if (ttd === null) return "rgba(255,255,255,0.3)";
    if (ttd < 10)  return "var(--neon-red)";
    if (ttd < 60)  return "var(--neon-amber)";
    if (ttd < 300) return "rgba(255,200,0,0.6)";
    return "var(--neon-green)";
  };

  const speedGlow = (ttd: number | null) => {
    if (ttd === null) return "none";
    if (ttd < 10)  return "0 0 8px rgba(255,51,102,0.5)";
    if (ttd < 60)  return "0 0 8px rgba(255,170,0,0.4)";
    return "none";
  };

  return (
    <div className="space-y-5">
      {/* Header + Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold font-mono" style={{color:"var(--neon-red)",textShadow:"0 0 10px rgba(255,51,102,0.4)"}}>
          🗑 DELETED FEED
        </h2>
        <div className="flex-1" />
        <select value={speed} onChange={e => setSpeed(e.target.value)}
          className="rounded-lg px-3 py-2 text-xs font-mono outline-none"
          style={{background:"rgba(8,8,24,0.95)",border:"1px solid rgba(0,200,255,0.15)",color:"rgba(0,200,255,0.7)"}}>
          <option value="">Barcha tezliklar</option>
          <option value="quick">⚡ Quick (&lt;10s)</option>
          <option value="fast">🔴 Fast (&lt;1min)</option>
          <option value="slow">🟢 Slow (&gt;1min)</option>
        </select>
        <select value={chatFilter} onChange={e => setChatFilter(e.target.value)}
          className="rounded-lg px-3 py-2 text-xs font-mono outline-none"
          style={{background:"rgba(8,8,24,0.95)",border:"1px solid rgba(0,200,255,0.15)",color:"rgba(0,200,255,0.7)"}}>
          <option value="">Barcha guruhlar</option>
          {groups.map(g => <option key={g.chat_id} value={g.chat_id}>{g.chat_title || g.chat_id}</option>)}
        </select>
        <input value={sender} onChange={e => setSender(e.target.value)}
          placeholder="username / ism..."
          className="rounded-lg px-3 py-2 text-xs font-mono outline-none w-36"
          style={{background:"rgba(8,8,24,0.95)",border:"1px solid rgba(0,200,255,0.15)",color:"rgba(0,200,255,0.7)"}} />
        <button onClick={load}
          className="px-4 py-2 rounded-lg text-xs font-mono font-bold transition-all"
          style={{background:"rgba(255,51,102,0.08)",border:"1px solid rgba(255,51,102,0.3)",color:"var(--neon-red)"}}>
          ↻ YANGILASH
        </button>
      </div>

      {/* Stats */}
      {data && (
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: "JAMI",        value: data.total,              color: "var(--neon-red)" },
            { label: "⚡ QUICK",    value: data.stats.quick_deletes, color: "var(--neon-red)",   glow: "0 0 8px rgba(255,51,102,0.4)" },
            { label: "🔴 FAST",     value: data.stats.fast_deletes,  color: "var(--neon-amber)", glow: "0 0 8px rgba(255,170,0,0.3)" },
            { label: "📝 MATN BOR", value: data.stats.with_text,     color: "var(--neon-blue)" },
            { label: "❓ MA'LUMOT YO'Q", value: data.stats.no_info, color: "rgba(255,255,255,0.3)" },
          ].map(s => (
            <div key={s.label} className="rounded-xl p-4 relative overflow-hidden"
              style={{background:"rgba(8,8,24,0.95)",border:`1px solid ${s.color}30`}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${s.color},transparent)`}} />
              <div className="text-[9px] font-mono mb-1" style={{color:`${s.color}80`}}>{s.label}</div>
              <div className="text-2xl font-bold tabular-nums" style={{color:s.color,textShadow:s.glow||"none"}}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {loading && <Loader />}

      {!loading && data && (
        <div className="grid grid-cols-2 gap-4">
          {/* Left: list */}
          <div className="space-y-2 max-h-[700px] overflow-y-auto pr-1">
            {data.events.length === 0 && <Empty text="O'chirilgan xabar topilmadi" />}
            {data.events.map(e => (
              <div key={e.id} onClick={() => setSelected(e)}
                className="w-full text-left rounded-xl p-4 transition-all space-y-3 cursor-pointer"
                style={{
                  background: selected?.id === e.id ? "rgba(255,51,102,0.06)" : "rgba(8,8,24,0.95)",
                  border: selected?.id === e.id
                    ? "1px solid rgba(255,51,102,0.4)"
                    : "1px solid rgba(255,51,102,0.15)",
                  boxShadow: selected?.id === e.id ? "0 0 12px rgba(255,51,102,0.15)" : "none",
                }}>
                {/* Top row */}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Speed badge */}
                  <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded"
                    style={{color:speedColor(e.time_to_delete),background:`${speedColor(e.time_to_delete)}15`,border:`1px solid ${speedColor(e.time_to_delete)}40`,boxShadow:speedGlow(e.time_to_delete)}}>
                    {e.time_to_delete !== null ? `${e.time_to_delete}s` : "?s"}
                  </span>
                  <span className="text-[10px] font-mono" style={{color:"rgba(0,200,255,0.4)"}}>
                    {e.chat_title || e.chat_id}
                  </span>
                  {e.keyword_alerts?.map(kw => (
                    <span key={kw} className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                      style={{background:"rgba(255,51,102,0.1)",color:"var(--neon-red)",border:"1px solid rgba(255,51,102,0.2)"}}>
                      {kw}
                    </span>
                  ))}
                  <span className="text-[10px] font-mono ml-auto" style={{color:"rgba(0,200,255,0.3)"}}>
                    {e.deleted_at?.slice(11,16)}
                  </span>
                </div>

                {/* Telegram bubble mini */}
                <div className="rounded-xl p-3" style={{background:"#182533",border:"1px solid rgba(255,51,102,0.2)"}}>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={{background:"linear-gradient(135deg,#3a1a1a,#ff3366)"}}>
                      {(e.original_sender_name || "?")[0]?.toUpperCase()}
                    </div>
                    <span className="text-xs font-semibold" style={{color:"#ff6b8a"}}>
                      {e.original_sender_name || "Unknown"}
                      {e.original_sender_username && <span style={{fontWeight:400,opacity:0.5}}> @{e.original_sender_username}</span>}
                    </span>
                  </div>
                  {e.original_text ? (
                    <p className="text-xs line-clamp-2" style={{color:"rgba(232,244,255,0.7)",textDecoration:"line-through",opacity:0.7}}>
                      {e.original_text}
                    </p>
                  ) : e.original_media_type ? (
                    <span className="text-[11px] font-mono" style={{color:"rgba(0,200,255,0.5)"}}>
                      [{e.original_media_type.toUpperCase()}]
                    </span>
                  ) : (
                    <LookupButton api={api} chatId={e.chat_id} messageId={e.message_id}
                      onFound={(data) => {
                        // Ma'lumot topilsa selected ni yangilaymiz
                        if (selected?.id === e.id) setSelected({...selected, original_text: data.text, original_media_type: data.media_type, original_media_path: data.media_path, original_sender_name: data.sender_name, original_sender_username: data.sender_username});
                      }} />
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Right: detail */}
          <div className="rounded-xl p-5 space-y-4 sticky top-20"
            style={{background:"rgba(8,8,24,0.95)",border:"1px solid rgba(255,51,102,0.15)",maxHeight:"700px",overflowY:"auto"}}>
            {!selected ? (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <div className="text-3xl">🗑</div>
                <div className="text-xs font-mono" style={{color:"rgba(255,255,255,0.25)"}}>Xabarni tanlang</div>
              </div>
            ) : (
              <>
                {/* Speed indicator */}
                <div className="flex items-center gap-3">
                  <div className="text-3xl font-bold font-mono tabular-nums"
                    style={{color:speedColor(selected.time_to_delete),textShadow:speedGlow(selected.time_to_delete)}}>
                    {selected.time_to_delete !== null ? `${selected.time_to_delete}s` : "?"}
                  </div>
                  <div>
                    <div className="text-xs font-mono" style={{color:"rgba(255,255,255,0.3)"}}>O'CHIRISH TEZLIGI</div>
                    <div className="text-xs font-mono mt-0.5" style={{color:"rgba(255,255,255,0.5)"}}>{selected.speed_label}</div>
                  </div>
                  <div className="ml-auto text-right">
                    <div className="text-[10px] font-mono" style={{color:"rgba(0,200,255,0.3)"}}>MSG ID</div>
                    <div className="text-sm font-mono" style={{color:"rgba(0,200,255,0.7)"}}>{selected.message_id}</div>
                  </div>
                </div>

                {/* Chat info */}
                <div className="rounded-lg p-3" style={{background:"rgba(0,200,255,0.04)",border:"1px solid rgba(0,200,255,0.1)"}}>
                  <div className="text-[10px] font-mono mb-1" style={{color:"rgba(0,200,255,0.4)"}}>GURUH</div>
                  <div className="text-sm font-mono">{selected.chat_title || selected.chat_id}</div>
                </div>

                {/* Timeline */}
                <div className="space-y-2">
                  <div className="text-[10px] font-mono" style={{color:"rgba(0,200,255,0.4)"}}>VAQT ORALIG'I</div>
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span style={{color:"var(--neon-green)"}}>📤 {selected.original_created_at?.slice(11,16) || "?"}</span>
                    <div className="flex-1 h-px" style={{background:`linear-gradient(90deg,var(--neon-green),${speedColor(selected.time_to_delete)})`}} />
                    <span style={{color:speedColor(selected.time_to_delete)}}>🗑 {selected.deleted_at?.slice(11,16) || "?"}</span>
                  </div>
                </div>

                {/* Original bubble */}
                <div>
                  <div className="text-[10px] font-mono mb-2" style={{color:"rgba(255,51,102,0.6)"}}>ORIGINAL XABAR</div>
                  <div className="rounded-xl p-4 space-y-2" style={{background:"#182533",border:"1px solid rgba(255,51,102,0.25)"}}>
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm"
                        style={{background:"linear-gradient(135deg,#3a1a1a,#ff3366)"}}>
                        {(selected.original_sender_name || "?")[0]?.toUpperCase()}
                      </div>
                      <div>
                        <div className="text-sm font-semibold" style={{color:"#ff6b8a"}}>
                          {selected.original_sender_name || "Unknown"}
                        </div>
                        {selected.original_sender_username && (
                          <div className="text-xs" style={{color:"rgba(255,107,138,0.6)"}}>@{selected.original_sender_username}</div>
                        )}
                      </div>
                    </div>

                    {/* Media */}
                    {selected.original_media_path && selected.original_media_type && (
                      <TgMedia mediaPath={selected.original_media_path} mediaType={selected.original_media_type} API_BASE={API} />
                    )}

                    {/* Text */}
                    {selected.original_text ? (
                      <p className="text-sm whitespace-pre-wrap" style={{color:"rgba(232,244,255,0.8)",textDecoration:"line-through",textDecorationColor:"rgba(255,51,102,0.5)"}}>
                        {selected.original_text}
                      </p>
                    ) : !selected.original_media_path ? (
                      <LookupButton api={api} chatId={selected.chat_id} messageId={selected.message_id}
                        onFound={(data) => setSelected(prev => prev ? {...prev,
                          original_text: data.text,
                          original_media_type: data.media_type,
                          original_media_path: data.media_path,
                          original_sender_name: data.sender_name,
                          original_sender_username: data.sender_username,
                        } : prev)} />
                    ) : null}

                    <div className="flex items-center justify-between">
                      <span className="text-[11px]" style={{color:"rgba(255,51,102,0.6)"}}>🗑 o'chirildi</span>
                      <span className="text-[11px]" style={{color:"rgba(255,255,255,0.3)"}}>{selected.original_created_at?.slice(11,16) || "?"}</span>
                    </div>
                  </div>
                </div>

                {/* Telegram link */}
                {selected.telegram_link && (
                  <a href={selected.telegram_link} target="_blank"
                    className="flex items-center gap-2 text-xs font-mono transition-colors"
                    style={{color:"var(--neon-blue)"}}>
                    ↗ TELEGRAMDA OCHISH
                  </a>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ANALYTICS TABS ───────────────────────────────────────────────────────────
// AnalyticsTab type below in ANALYTIC_TABS

type AnalyticsTab = "overview" | "edit" | "delete" | "media" | "forwards" | "links" | "mentions" | "keywords" | "phrases" | "timeline" | "suspicious" | "clusters" | "deleted_feed";

const ANALYTIC_TABS: { key: AnalyticsTab; label: string; highlight?: boolean }[] = [
  { key: "deleted_feed", label: "🗑 DELETED FEED", highlight: true },
  { key: "overview",   label: "OVERVIEW" },
  { key: "edit",       label: "EDITS" },
  { key: "delete",     label: "DELETES" },
  { key: "media",      label: "MEDIA" },
  { key: "forwards",   label: "FORWARDS" },
  { key: "links",      label: "LINKS" },
  { key: "mentions",   label: "MENTIONS" },
  { key: "keywords",   label: "ALERTS" },
  { key: "phrases",    label: "PHRASES" },
  { key: "timeline",   label: "TIMELINE" },
  { key: "suspicious", label: "SUSPICIOUS" },
  { key: "clusters",   label: "CLUSTERS" },
];

// ── Overview tab ──────────────────────────────────────────────────────────────
function OverviewTab({ date, api }: { date: string; api: Api }) {
  const { addToast } = useToast();
  const [hourly, setHourly] = useState<HourlyData[]>([]);
  const [topGroups, setTopGroups] = useState<TopGroup[]>([]);
  const [topSenders, setTopSenders] = useState<TopSender[]>([]);
  const [weekly, setWeekly] = useState<WeeklyTrend[]>([]);
  const [dist, setDist] = useState<EventDist[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get(`/analytics/hourly?date=${date}`).then(r => setHourly(r.data)),
      api.get(`/analytics/top-active?date=${date}&limit=8`).then(r => setTopGroups(r.data)),
      api.get(`/analytics/top-senders?date=${date}&limit=8`).then(r => setTopSenders(r.data)),
      api.get(`/analytics/weekly-trend`).then(r => setWeekly(r.data)),
      api.get(`/analytics/event-distribution?date=${date}`).then(r => setDist(r.data)),
    ])
      .catch(err => addToast(err?.response?.data?.detail || "Overview yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date]);

  if (loading) return <Loader />;
  const totalDist = dist.reduce((s, e) => s + e.count, 0);
  const distColors: Record<string, string> = { new_message: "#34d399", edited_message: "#fbbf24", deleted_message: "#f87171", missing_ids: "#a78bfa", media_download: "#38bdf8" };
  const maxSender = Math.max(...topSenders.map(s => s.total), 1);
  const maxGroup = Math.max(...topGroups.map(g => g.total), 1);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Weekly trend" />
          <WeeklySparkline data={weekly} />
        </div>
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Event distribution" />
          <div className="space-y-2">
            {dist.map(e => {
              const pct = totalDist ? Math.round((e.count / totalDist) * 100) : 0;
              const color = distColors[e.event_type] || "#71717a";
              return (
                <div key={e.event_type} className="space-y-1">
                  <div className="flex justify-between text-[11px] font-mono">
                    <span style={{ color }}>{e.event_type.toUpperCase()}</span>
                    <span className="text-[rgba(255,255,255,0.55)]">{e.count} <span className="text-[rgba(0,200,255,0.3)]">({pct}%)</span></span>
                  </div>
                  <div className="h-1.5 bg-[rgba(0,200,255,0.06)] rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
        <SectionHeader title="Hourly heatmap" />
        <HourlyHeatmap data={hourly} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Top active groups" count={topGroups.length} />
          <div className="space-y-1">
            {topGroups.map((g, i) => (
              <BarRow key={g.chat_id} label={`${i + 1}. ${g.chat_title}`} value={g.total} max={maxGroup} right={<span className="text-[10px] font-mono text-rose-400">{g.delete_rate}% del</span>} />
            ))}
            {!topGroups.length && <Empty />}
          </div>
        </div>
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Top senders" count={topSenders.length} />
          <div className="space-y-1">
            {topSenders.map((s, i) => (
              <BarRow key={s.sender_id} label={`${i + 1}. ${s.sender_username ? "@" + s.sender_username : s.sender_name}`} value={s.total} max={maxSender} color="#34d399" right={<span className="text-[10px] font-mono text-rose-400">{s.deleted}d</span>} />
            ))}
            {!topSenders.length && <Empty />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Edit tab ──────────────────────────────────────────────────────────────────
function EditTab({ date, api, chatId }: { date: string; api: Api; chatId?: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get(`/analytics/edit-analytics?date=${date}${chatId ? `&chat_id=${chatId}` : ""}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, chatId]);
  if (loading) return <Loader />;
  if (!data) return <Empty />;
  const maxU = Math.max(...(data.most_edited_users || []).map((u: any) => u.count), 1);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="TOTAL EDITS" value={data.total_edits} accent="border-amber-800/40" />
        <StatCard label="UNIQUE EDITORS" value={data.most_edited_users?.length || 0} accent="border-[rgba(0,200,255,0.15)]" />
        <StatCard label="MULTI-EDITED MSGS" value={data.most_edited_messages?.filter((m: any) => m.edit_count > 1).length || 0} accent="border-[rgba(0,200,255,0.15)]" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Most edited users" />
          {(data.most_edited_users || []).map((u: any) => (
            <BarRow key={u.user} label={u.user} value={u.count} max={maxU} color="#fbbf24" />
          ))}
          {!data.most_edited_users?.length && <Empty />}
        </div>
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Most edited messages" />
          {(data.most_edited_messages || []).map((m: any) => (
            <div key={m.message_id} className="flex items-center justify-between py-1.5 border-b border-[rgba(0,200,255,0.1)]/50 last:border-0">
              <span className="text-xs font-mono text-[rgba(255,255,255,0.55)]">msg #{m.message_id}</span>
              <Pill label={`${m.edit_count}x edited`} color="amber" />
            </div>
          ))}
          {!data.most_edited_messages?.length && <Empty />}
        </div>
      </div>
      <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
        <SectionHeader title="Recent diffs" count={data.recent_diffs?.length} />
        <div className="space-y-4">
          {(data.recent_diffs || []).map((d: any, i: number) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-mono text-[rgba(0,200,255,0.45)]">
                <span>{d.sender_username ? "@" + d.sender_username : d.sender_name}</span>
                <span className="text-[rgba(0,200,255,0.2)]">·</span>
                <span>{d.chat_title || d.chat_id}</span>
                <span className="text-[rgba(0,200,255,0.2)]">·</span>
                <span>{timeStr(d.created_at)}</span>
              </div>
              <DiffView oldText={d.old_text} newText={d.new_text} />
            </div>
          ))}
          {!data.recent_diffs?.length && <Empty text="No diffs found" />}
        </div>
      </div>
    </div>
  );
}

// ── Delete tab ────────────────────────────────────────────────────────────────
function DeleteTab({ date, api, chatId }: { date: string; api: Api; chatId?: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get(`/analytics/delete-analytics?date=${date}${chatId ? `&chat_id=${chatId}` : ""}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, chatId]);
  if (loading) return <Loader />;
  if (!data) return <Empty />;
  const buckets = data.speed_buckets || {};
  const maxB = Math.max(...Object.values(buckets) as number[], 1);
  const bucketLabels: Record<string, string> = { lt_10s: "< 10 seconds", lt_1min: "< 1 minute", lt_5min: "< 5 minutes", lt_1h: "< 1 hour", gt_1h: "> 1 hour", unknown: "Unknown" };
  const bucketColors: Record<string, string> = { lt_10s: "#f87171", lt_1min: "#fb923c", lt_5min: "#fbbf24", lt_1h: "#34d399", gt_1h: "#38bdf8", unknown: "#71717a" };
  const maxU = Math.max(...(data.most_deleted_users || []).map((u: any) => u.count), 1);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="TOTAL DELETED" value={data.total_deleted} accent="border-neon-red glow-red card-accent-red" />
        <StatCard label="QUICK DELETES (<10s)" value={buckets.lt_10s || 0} sub="Suspicious behavior" accent="border-neon-red glow-red card-accent-red" />
        <StatCard label="UNIQUE DELETERS" value={data.most_deleted_users?.length || 0} accent="border-[rgba(0,200,255,0.15)]" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Delete speed buckets" />
          <div className="space-y-1">
            {Object.entries(bucketLabels).map(([key, label]) => (
              <BarRow key={key} label={label} value={buckets[key] || 0} max={maxB} color={bucketColors[key]} />
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Most deleted users" />
          {(data.most_deleted_users || []).map((u: any) => (
            <BarRow key={u.user} label={u.user} value={u.count} max={maxU} color="#f87171" />
          ))}
          {!data.most_deleted_users?.length && <Empty />}
        </div>
      </div>

      {data.quick_delete_samples?.length > 0 && (
        <div className="rounded-xl border border-rose-900/40 bg-rose-950/10 p-5">
          <SectionHeader title="Quick delete samples (< 10s)" count={data.quick_delete_samples.length} />
          <div className="space-y-3">
            {data.quick_delete_samples.map((s: any, i: number) => (
              <div key={i} className="flex items-start gap-3 py-2 border-b border-[rgba(0,200,255,0.1)]/50 last:border-0">
                <div className="w-14 shrink-0 text-center">
                  <div className="text-lg font-bold font-mono text-rose-400">{s.delta_sec}s</div>
                  <div className="text-[9px] text-[rgba(0,200,255,0.3)] font-mono">after send</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-mono text-[rgba(255,255,255,0.55)] mb-1">{s.sender_username ? "@" + s.sender_username : s.sender_name} · msg #{s.message_id}</div>
                  <div className="text-xs text-[rgba(0,200,255,0.45)] font-mono truncate italic">"{s.text_preview || "—"}"</div>
                </div>
                <div className="text-[10px] font-mono text-[rgba(0,200,255,0.3)] shrink-0">{timeStr(s.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Media tab ─────────────────────────────────────────────────────────────────
function MediaTab({ date, api, chatId }: { date: string; api: Api; chatId?: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get(`/analytics/media-analytics?date=${date}${chatId ? `&chat_id=${chatId}` : ""}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, chatId]);
  if (loading) return <Loader />;
  if (!data) return <Empty />;

  const icons: Record<string, string> = { photo: "📷", video: "🎬", gif: "🎞", sticker: "🎭", animated_sticker: "✨", video_sticker: "🎪", voice: "🎙", audio: "🎵", video_note: "🎥", document: "📄" };
  const breakdown = data.breakdown || {};
  const maxV = Math.max(...Object.values(breakdown) as number[], 1);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Media breakdown" />
          {Object.entries(breakdown).map(([type, count]: any) => (
            <div key={type} className="flex items-center gap-3 py-1.5">
              <span className="text-base w-8">{icons[type] || "📎"}</span>
              <div className="w-24 shrink-0 text-xs font-mono text-[rgba(255,255,255,0.55)] capitalize">{type.replace("_", " ")}</div>
              <div className="flex-1 h-1.5 bg-[rgba(0,200,255,0.06)] rounded-full overflow-hidden">
                <div className="h-full bg-sky-500 rounded-full" style={{ width: `${(count / maxV) * 100}%` }} />
              </div>
              <div className="text-xs font-mono text-[rgba(255,255,255,0.55)] tabular-nums w-8 text-right">{count}</div>
            </div>
          ))}
          {!Object.keys(breakdown).length && <Empty />}
        </div>
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5 flex items-center justify-center">
          <div className="text-center">
            <div className="text-5xl font-bold text-sky-400">{data.total_media}</div>
            <div className="text-xs font-mono text-[rgba(0,200,255,0.3)] mt-2 tracking-widest">TOTAL MEDIA FILES</div>
          </div>
        </div>
      </div>

      {data.gallery?.length > 0 && (
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Gallery" count={data.gallery.length} />
          <div className="grid grid-cols-6 gap-2">
            {data.gallery.map((item: any, i: number) => {
              const url = `${API}/${(item.media_path || "").replaceAll("\\", "/")}`;
              return (
                <a key={i} href={url} target="_blank"
                  className="aspect-square rounded-lg overflow-hidden bg-[rgba(0,200,255,0.06)] border border-[rgba(0,200,255,0.15)] hover:border-sky-500 transition-colors relative group">
                  {item.media_type === "photo" && <img src={url} className="w-full h-full object-cover" />}
                  {item.media_type === "gif" && <video src={url} autoPlay loop muted className="w-full h-full object-cover" />}
                  {item.media_type === "video" && <video src={url} className="w-full h-full object-cover" />}
                  {!["photo", "gif", "video"].includes(item.media_type) && (
                    <div className="w-full h-full flex items-center justify-center text-2xl">{icons[item.media_type] || "📎"}</div>
                  )}
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-1">
                    <span className="text-[9px] font-mono text-white truncate">{item.sender_username ? "@" + item.sender_username : item.sender_name}</span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Forwards tab ──────────────────────────────────────────────────────────────
function ForwardsTab({ date, api, chatId }: { date: string; api: Api; chatId?: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get(`/analytics/forward-analytics?date=${date}${chatId ? `&chat_id=${chatId}` : ""}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, chatId]);
  if (loading) return <Loader />;
  if (!data) return <Empty />;
  const maxS = Math.max(...(data.top_sources || []).map((s: any) => s.count), 1);
  const maxD = Math.max(...(data.top_destinations || []).map((d: any) => d.count), 1);
  return (
    <div className="space-y-6">
      <StatCard label="TOTAL FORWARDED MESSAGES" value={data.total_forwarded} accent="border-neon-blue glow-blue card-accent-blue" />
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Top forward sources" count={data.top_sources?.length} />
          {(data.top_sources || []).map((s: any) => <BarRow key={s.source} label={s.source} value={s.count} max={maxS} color="#38bdf8" />)}
          {!data.top_sources?.length && <Empty />}
        </div>
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Top destinations" count={data.top_destinations?.length} />
          {(data.top_destinations || []).map((d: any) => <BarRow key={d.chat} label={d.chat} value={d.count} max={maxD} color="#a78bfa" />)}
          {!data.top_destinations?.length && <Empty />}
        </div>
      </div>
    </div>
  );
}

// ── Links tab ─────────────────────────────────────────────────────────────────
function LinksTab({ date, api, chatId }: { date: string; api: Api; chatId?: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get(`/analytics/link-analytics?date=${date}${chatId ? `&chat_id=${chatId}` : ""}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, chatId]);
  if (loading) return <Loader />;
  if (!data) return <Empty />;
  const catColors: Record<string, string> = { telegram: "#38bdf8", youtube: "#f87171", instagram: "#f472b6", twitter: "#60a5fa", crypto: "#34d399" };
  const catIcons: Record<string, string> = { telegram: "✈", youtube: "▶", instagram: "◉", twitter: "◆", crypto: "₿" };
  const maxC = Math.max(...Object.values(data.category_counts || {}) as number[], 1);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
        <SectionHeader title="Link categories" />
        {Object.entries(data.category_counts || {}).map(([cat, count]: any) => (
          <div key={cat} className="flex items-center gap-3 py-1.5">
            <span className="text-sm w-6 text-center" style={{ color: catColors[cat] || "#71717a" }}>{catIcons[cat] || "◎"}</span>
            <div className="w-24 shrink-0 text-xs font-mono capitalize" style={{ color: catColors[cat] || "#a1a1aa" }}>{cat}</div>
            <div className="flex-1 h-1.5 bg-[rgba(0,200,255,0.06)] rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${(count / maxC) * 100}%`, backgroundColor: catColors[cat] || "#71717a" }} />
            </div>
            <div className="text-xs font-mono text-[rgba(255,255,255,0.55)] tabular-nums w-8 text-right">{count}</div>
          </div>
        ))}
        {!Object.keys(data.category_counts || {}).length && <Empty text="No links found" />}
      </div>

      {Object.entries(data.top_links_by_category || {}).map(([cat, links]: any) => (
        <div key={cat} className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title={`Top ${cat} links`} count={links.length} />
          <div className="space-y-2">
            {links.map((l: any, i: number) => (
              <div key={i} className="flex items-center gap-3 py-1.5 border-b border-[rgba(0,200,255,0.1)]/50 last:border-0">
                <span className="text-[10px] font-mono text-[rgba(0,200,255,0.3)] w-4">{i + 1}</span>
                <a href={`https://${l.url}`} target="_blank" className="flex-1 text-xs font-mono truncate" style={{ color: catColors[cat] || "#38bdf8" }}>{l.url}</a>
                <Pill label={`${l.count}x`} color="zinc" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Mentions tab ──────────────────────────────────────────────────────────────
function MentionsTab({ date, api, chatId }: { date: string; api: Api; chatId?: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get(`/analytics/mention-analytics?date=${date}${chatId ? `&chat_id=${chatId}` : ""}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, chatId]);
  if (loading) return <Loader />;
  if (!data) return <Empty />;
  const maxM = Math.max(...(data.top_mentioned || []).map((m: any) => m.count), 1);
  const maxR = Math.max(...(data.top_mentioners || []).map((m: any) => m.mention_count), 1);
  return (
    <div className="space-y-6">
      <StatCard label="TOTAL MENTIONS" value={data.total_mentions} accent="border-neon-blue glow-blue card-accent-blue" />
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Top mentioned" count={data.top_mentioned?.length} />
          {(data.top_mentioned || []).map((m: any) => <BarRow key={m.username} label={`@${m.username}`} value={m.count} max={maxM} color="#38bdf8" />)}
          {!data.top_mentioned?.length && <Empty />}
        </div>
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Top mentioners" count={data.top_mentioners?.length} />
          {(data.top_mentioners || []).map((m: any) => <BarRow key={m.sender} label={m.sender} value={m.mention_count} max={maxR} color="#a78bfa" />)}
          {!data.top_mentioners?.length && <Empty />}
        </div>
      </div>
    </div>
  );
}

// ── Keywords tab ──────────────────────────────────────────────────────────────
// ── Keyword manager sub-component (admin/analytic) ───────────────────────────
function KeywordManager({ api, role }: { api: Api; role: string }) {
  const { addToast } = useToast();
  const [kwData, setKwData] = useState<any>(null);
  const [newKw, setNewKw] = useState("");
  const [saving, setSaving] = useState(false);

  const canManage = role === "admin" || role === "analytic";

  const loadKeywords = useCallback(() => {
    api.get("/keywords").then(r => setKwData(r.data)).catch(() => {});
  }, [api]);

  useEffect(() => { loadKeywords(); }, [loadKeywords]);

  const handleAdd = async () => {
    const kw = newKw.trim().toLowerCase();
    if (!kw) return;
    setSaving(true);
    try {
      await api.post(`/keywords?keyword=${encodeURIComponent(kw)}`);
      addToast(`"${kw}" qo'shildi`, "success");
      setNewKw("");
      loadKeywords();
    } catch (err: any) {
      addToast(err?.response?.data?.detail || "Qo'shishda xato", "error");
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number, kw: string) => {
    try {
      await api.delete(`/keywords/${id}`);
      addToast(`"${kw}" o'chirildi`, "warning");
      loadKeywords();
    } catch (err: any) {
      addToast(err?.response?.data?.detail || "O'chirishda xato", "error");
    }
  };

  const handleSeedFromEnv = async () => {
    try {
      const r = await api.post("/keywords/seed-from-env");
      const added = r.data.seeded || [];
      addToast(added.length ? `${added.length} ta keyword .env dan import qilindi` : "Yangi keyword topilmadi", "info");
      loadKeywords();
    } catch (err: any) {
      addToast(err?.response?.data?.detail || "Xato", "error");
    }
  };

  if (!kwData) return <div className="text-[rgba(0,200,255,0.2)] font-mono text-xs py-4 text-center">Yuklanmoqda...</div>;

  const activeKws = (kwData.keywords || []).filter((k: any) => k.is_active);
  const inactiveKws = (kwData.keywords || []).filter((k: any) => !k.is_active);

  return (
    <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <SectionHeader title={`Keyword boshqaruvi · ${kwData.source === "env_fallback" ? ".env fallback" : "database"}`} count={activeKws.length} />
        {kwData.source === "env_fallback" && canManage && (
          <button onClick={handleSeedFromEnv}
            className="text-[10px] font-mono text-sky-400 hover:text-sky-300 border border-sky-800/50 px-3 py-1.5 rounded-lg transition-colors shrink-0">
            ↑ .env DAN IMPORT
          </button>
        )}
      </div>

      {/* Add input */}
      {canManage && (
        <div className="flex gap-2">
          <input
            value={newKw}
            onChange={e => setNewKw(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAdd()}
            placeholder="yangi keyword..."
            className="flex-1 rounded-lg bg-[#04040a] border border-[rgba(0,200,255,0.1)] px-4 py-2 text-sm font-mono outline-none focus:border-rose-500 transition-colors"
          />
          <button
            onClick={handleAdd}
            disabled={saving || !newKw.trim()}
            className="px-4 py-2 rounded-lg bg-rose-700 hover:bg-rose-600 disabled:opacity-40 transition-colors text-sm font-mono"
          >
            {saving ? "..." : "+ QO'SH"}
          </button>
        </div>
      )}

      {/* Active keywords */}
      <div className="flex flex-wrap gap-2">
        {activeKws.map((k: any) => (
          <div key={k.id ?? k.keyword}
            className="flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 group">
            <span>{k.keyword}</span>
            {canManage && k.id && (
              <button
                onClick={() => handleDelete(k.id, k.keyword)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-rose-500 hover:text-rose-300 ml-1 text-[11px]">
                ✕
              </button>
            )}
          </div>
        ))}
        {!activeKws.length && <div className="text-[rgba(0,200,255,0.3)] font-mono text-xs">Keyword yo'q</div>}
      </div>

      {/* Inactive (soft deleted) */}
      {inactiveKws.length > 0 && (
        <div>
          <div className="text-[10px] font-mono text-[rgba(0,200,255,0.3)] mb-2">O'CHIRILGANLAR</div>
          <div className="flex flex-wrap gap-2">
            {inactiveKws.map((k: any) => (
              <div key={k.id}
                className="flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded-lg bg-[rgba(0,200,255,0.06)]/50 border border-[rgba(0,200,255,0.15)]/50 text-[rgba(0,200,255,0.3)] line-through">
                {k.keyword}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Keywords tab ──────────────────────────────────────────────────────────────
function KeywordsTab({ date, api, chatId, role }: { date: string; api: Api; chatId?: string; role: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get(`/analytics/keyword-alerts?date=${date}${chatId ? `&chat_id=${chatId}` : ""}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, chatId]);

  return (
    <div className="space-y-6">
      {/* Keyword manager — har doim ko'rinadi */}
      <KeywordManager api={api} role={role} />

      {loading && <Loader />}

      {!loading && data && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <StatCard label="TOTAL ALERTS TODAY" value={data.total_alerts} accent="border-neon-red glow-red card-accent-red" />
            <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
              <SectionHeader title="Hit counts" />
              {Object.entries(data.keyword_counts || {}).length === 0 && <Empty text="Hech narsa topilmadi" />}
              {Object.entries(data.keyword_counts || {}).map(([kw, cnt]: any) => (
                <div key={kw} className="flex items-center justify-between py-1.5 border-b border-[rgba(0,200,255,0.1)]/50 last:border-0">
                  <span className="text-sm font-mono text-rose-300">{kw}</span>
                  <Pill label={`${cnt} hits`} color="red" />
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
            <SectionHeader title="Flagged messages" count={data.messages?.length} />
            <div className="space-y-3">
              {(data.messages || []).map((m: any) => (
                <div key={m.id} className="rounded-lg border border-rose-900/30 bg-rose-950/10 p-4 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {(m.matched_keywords || []).map((kw: string) => (
                      <span key={kw} className="text-[10px] font-mono font-bold px-2 py-0.5 rounded border tracking-widest bg-rose-500/20 text-rose-300 border-rose-500/40">
                        {kw.toUpperCase()}
                      </span>
                    ))}
                    <span className="text-[10px] font-mono text-[rgba(0,200,255,0.3)] ml-auto">{timeStr(m.created_at)}</span>
                  </div>
                  <div className="text-xs font-mono text-[rgba(0,200,255,0.45)]">
                    {m.sender_username ? "@" + m.sender_username : m.sender_name} · {m.chat_title}
                  </div>
                  {/* Keyword highlight bilan text */}
                  <p className="text-xs text-[rgba(255,255,255,0.75)] font-mono whitespace-pre-wrap leading-relaxed">
                    {m.text?.split(new RegExp(`(${(m.matched_keywords || []).join("|")})`, "gi")).map((part: string, i: number) => {
                      const isMatch = (m.matched_keywords || []).some((kw: string) => kw.toLowerCase() === part.toLowerCase());
                      return isMatch
                        ? <mark key={i} className="bg-rose-500/30 text-rose-200 rounded px-0.5">{part}</mark>
                        : <span key={i}>{part}</span>;
                    })}
                  </p>
                  {m.telegram_link && (
                    <a href={m.telegram_link} target="_blank" className="text-[10px] font-mono text-sky-400 hover:underline">↗ Open in Telegram</a>
                  )}
                </div>
              ))}
              {!data.messages?.length && <Empty text="Bugun alert topilmadi" />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Phrases tab ───────────────────────────────────────────────────────────────
function PhrasesTab({ date, api, chatId }: { date: string; api: Api; chatId?: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get(`/analytics/phrase-analytics?date=${date}${chatId ? `&chat_id=${chatId}` : ""}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, chatId]);
  if (loading) return <Loader />;
  if (!data) return <Empty />;
  const maxP = Math.max(...(data.most_repeated_phrases || []).map((p: any) => p.count), 1);
  const maxW = Math.max(...(data.most_repeated_words || []).map((w: any) => w.count), 1);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5 col-span-2">
          <SectionHeader title="Most repeated phrases" />
          {(data.most_repeated_phrases || []).map((p: any) => <BarRow key={p.phrase} label={p.phrase} value={p.count} max={maxP} color="#a78bfa" />)}
          {!data.most_repeated_phrases?.length && <Empty />}
        </div>
        <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5">
          <SectionHeader title="Top words" />
          <div className="flex flex-wrap gap-1.5">
            {(data.most_repeated_words || []).map((w: any) => (
              <span key={w.word} className="text-xs font-mono px-2 py-1 rounded bg-[rgba(0,200,255,0.06)] text-[rgba(255,255,255,0.75)] border border-[rgba(0,200,255,0.15)]"
                style={{ fontSize: `${Math.max(10, Math.min(16, 10 + (w.count / maxW) * 6))}px` }}>
                {w.word}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="rounded-xl border border-purple-900/40 bg-purple-950/10 p-5">
        <SectionHeader title="Trending today (new phrases)" count={data.trending_today?.length} />
        <div className="space-y-2">
          {(data.trending_today || []).map((t: any, i: number) => (
            <div key={i} className="flex items-center gap-3 py-2 border-b border-[rgba(0,200,255,0.1)]/50 last:border-0">
              <div className="text-[10px] font-mono text-purple-400 w-5">#{i + 1}</div>
              <div className="flex-1 text-sm font-mono text-[rgba(255,255,255,0.75)]">"{t.phrase}"</div>
              <div className="flex items-center gap-2 shrink-0">
                {t.first_half === 0 && <Pill label="NEW" color="purple" />}
                <span className="text-xs font-mono text-[rgba(255,255,255,0.55)]">{t.count}x</span>
              </div>
            </div>
          ))}
          {!data.trending_today?.length && <Empty text="No trending phrases found" />}
        </div>
      </div>
    </div>
  );
}

// ── Timeline tab ──────────────────────────────────────────────────────────────
function TimelineTab({ date, api, groups }: { date: string; api: Api; groups: Group[] }) {
  const [selectedChatId, setSelectedChatId] = useState("");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!selectedChatId) return;
    setLoading(true); setCursor(0); setPlaying(false);
    api.get(`/analytics/timeline?date=${date}&chat_id=${selectedChatId}`)
      .then(r => setEvents(r.data.events || [])).finally(() => setLoading(false));
  }, [selectedChatId, date]);

  useEffect(() => {
    if (!playing) { if (playRef.current) clearInterval(playRef.current); return; }
    playRef.current = setInterval(() => {
      setCursor(c => {
        if (c >= events.length - 1) { setPlaying(false); return c; }
        return c + 1;
      });
    }, 800);
    return () => { if (playRef.current) clearInterval(playRef.current); };
  }, [playing, events.length]);

  const visibleEvents = events.slice(0, cursor + 1);
  const evColors: Record<string, string> = { new_message: "bg-emerald-500", edited_message: "bg-amber-500", deleted_message: "bg-rose-500", missing_ids: "bg-violet-500" };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <select value={selectedChatId} onChange={e => setSelectedChatId(e.target.value)}
          className="flex-1 max-w-xs rounded-lg bg-[#0a0a1c] border border-[rgba(0,200,255,0.1)] px-4 py-2 text-sm font-mono outline-none focus:border-sky-500">
          <option value="">— Select a group —</option>
          {groups.map(g => <option key={g.chat_id} value={g.chat_id}>{g.chat_title || g.chat_id}</option>)}
        </select>
        {events.length > 0 && (
          <>
            <button onClick={() => setCursor(c => Math.max(0, c - 1))} className="px-3 py-2 rounded-lg border border-[rgba(0,200,255,0.15)] text-sm font-mono hover:bg-[rgba(0,200,255,0.06)] transition-colors" disabled={cursor === 0}>‹ PREV</button>
            <button onClick={() => setPlaying(p => !p)} className={`px-4 py-2 rounded-lg text-sm font-mono transition-colors ${playing ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500"}`}>
              {playing ? "⏸ PAUSE" : "▶ PLAY"}
            </button>
            <button onClick={() => setCursor(c => Math.min(events.length - 1, c + 1))} className="px-3 py-2 rounded-lg border border-[rgba(0,200,255,0.15)] text-sm font-mono hover:bg-[rgba(0,200,255,0.06)] transition-colors" disabled={cursor >= events.length - 1}>NEXT ›</button>
            <button onClick={() => { setCursor(0); setPlaying(false); }} className="px-3 py-2 rounded-lg border border-[rgba(0,200,255,0.15)] text-sm font-mono hover:bg-[rgba(0,200,255,0.06)] transition-colors">↺ RESET</button>
            <div className="text-xs font-mono text-[rgba(0,200,255,0.45)] ml-auto">{cursor + 1} / {events.length}</div>
          </>
        )}
      </div>

      {/* Progress bar */}
      {events.length > 0 && (
        <div className="h-1 bg-[rgba(0,200,255,0.06)] rounded-full overflow-hidden">
          <div className="h-full bg-sky-500 transition-all duration-300" style={{ width: `${((cursor + 1) / events.length) * 100}%` }} />
        </div>
      )}

      {loading && <Loader />}

      {!loading && selectedChatId && events.length === 0 && <Empty text="No events for this group on this day" />}

      {!loading && !selectedChatId && <Empty text="Select a group to start timeline replay" />}

      {!loading && events.length > 0 && (
        <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          {visibleEvents.map((e, i) => (
            <div key={e.id}
              className="flex items-start gap-3 rounded-lg p-3 transition-all duration-300"
              style={i === visibleEvents.length - 1
                ? {border:"1px solid rgba(0,200,255,0.5)",background:"rgba(0,200,255,0.05)",boxShadow:"0 0 16px rgba(0,200,255,0.15),inset 0 0 8px rgba(0,200,255,0.04)"}
                : {border:"1px solid rgba(0,200,255,0.08)",background:"rgba(8,8,24,0.9)"}}>
              <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
                <div className={`w-2 h-2 rounded-full ${evColors[e.event_type] || "bg-zinc-500"}`} />
                <div className="w-px flex-1 bg-[rgba(0,200,255,0.06)] min-h-[8px]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-[10px] font-mono text-[rgba(0,200,255,0.45)] tabular-nums">{e.time_label}</span>
                  <Badge type={e.event_type} />
                  {e.keyword_alerts?.map(kw => <Pill key={kw} label={kw} color="red" />)}
                  {e.is_forwarded && <Pill label="FWD" color="blue" />}
                  <span className="text-xs font-mono text-[rgba(255,255,255,0.55)]">{e.sender_username ? "@" + e.sender_username : e.sender_name}</span>
                </div>
                {e.text && <p className="text-xs font-mono text-[rgba(255,255,255,0.55)] line-clamp-2">{e.text}</p>}
                {e.new_text && <p className="text-xs font-mono text-emerald-400 line-clamp-1">+ {e.new_text}</p>}
                {e.media_type && e.media_type !== "pending" && <Pill label={e.media_type.toUpperCase()} color="blue" />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Suspicious tab ────────────────────────────────────────────────────────────
function SuspiciousTab({ date, api, chatId }: { date: string; api: Api; chatId?: string }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get(`/analytics/suspicious?date=${date}${chatId ? `&chat_id=${chatId}` : ""}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [date, chatId]);
  if (loading) return <Loader />;
  if (!data) return <Empty />;

  function scoreColor(score: number) {
    if (score >= 60) return "text-rose-400";
    if (score >= 30) return "text-amber-400";
    return "text-emerald-400";
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <StatCard label="SUSPICIOUS USERS" value={data.total_suspicious_users} accent="border-neon-red glow-red card-accent-red" />
        <div className="flex-1 text-xs font-mono text-[rgba(0,200,255,0.3)] leading-relaxed">
          Score: 40+ spam burst · 35+ repeated message · 30+ high delete rate · 20+ mass forwarding · 15+ high edit rate
        </div>
      </div>

      {!data.suspicious_users?.length && <Empty text="No suspicious behavior detected" />}

      <div className="space-y-3">
        {(data.suspicious_users || []).map((u: any, i: number) => (
          <div key={u.user} className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-5 space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-[rgba(0,200,255,0.06)] flex items-center justify-center text-sm font-bold border border-[rgba(0,200,255,0.15)] uppercase">
                {(u.user || "?")[0]}
              </div>
              <div className="flex-1">
                <div className="font-semibold font-mono">{u.user}</div>
                <div className="flex items-center gap-3 mt-1 text-[11px] font-mono text-[rgba(0,200,255,0.45)]">
                  <span>{u.stats.sent} sent</span>
                  <span className="text-rose-400">{u.stats.deleted} deleted</span>
                  <span className="text-amber-400">{u.stats.edited} edited</span>
                  <span className="text-sky-400">{u.stats.forwarded} fwd</span>
                </div>
              </div>
              <div className="text-right">
                <div className={`text-3xl font-bold font-mono tabular-nums ${scoreColor(u.score)}`}>{u.score}</div>
                <div className="text-[10px] font-mono text-[rgba(0,200,255,0.3)]">RISK SCORE</div>
              </div>
            </div>
            <div className="space-y-1.5">
              {(u.flags || []).map((flag: string, j: number) => (
                <div key={j} className="flex items-start gap-2 text-xs font-mono">
                  <span className="text-rose-400 mt-0.5 shrink-0">⚑</span>
                  <span className="text-[rgba(255,255,255,0.75)]">{flag}</span>
                </div>
              ))}
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{background:"rgba(0,200,255,0.06)"}}>
              <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(u.score, 100)}%`, backgroundColor: u.score >= 60 ? "var(--neon-red)" : u.score >= 30 ? "var(--neon-amber)" : "var(--neon-green)", boxShadow: u.score >= 60 ? "0 0 6px var(--neon-red)" : u.score >= 30 ? "0 0 6px var(--neon-amber)" : "0 0 6px var(--neon-green)" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Clusters tab ──────────────────────────────────────────────────────────────
function ClustersTab({ date, api, groups }: { date: string; api: Api; groups: Group[] }) {
  const { addToast } = useToast();
  const [selectedChatId, setSelectedChatId] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!selectedChatId) return;
    setLoading(true);
    api.get(`/analytics/conversation-clusters?date=${date}&chat_id=${selectedChatId}`)
      .then(r => setData(r.data))
      .catch(err => addToast(err?.response?.data?.detail || err?.message || "Ma'lumot yuklashda xato", "error"))
      .finally(() => setLoading(false));
  }, [selectedChatId, date]);

  return (
    <div className="space-y-5">
      <select value={selectedChatId} onChange={e => setSelectedChatId(e.target.value)}
        className="max-w-xs rounded-lg bg-[#0a0a1c] border border-[rgba(0,200,255,0.1)] px-4 py-2 text-sm font-mono outline-none focus:border-sky-500">
        <option value="">— Select a group —</option>
        {groups.map(g => <option key={g.chat_id} value={g.chat_id}>{g.chat_title || g.chat_id}</option>)}
      </select>
      {loading && <Loader />}
      {!loading && data && <NodeGraph nodes={data.nodes || []} edges={data.edges || []} />}
      {!loading && !selectedChatId && <Empty text="Select a group to view conversation clusters" />}
    </div>
  );
}

// ─── ANALYTICS PAGE ───────────────────────────────────────────────────────────
function AnalyticsPage({ date, api, groups, currentUser }: { date: string | null; api: Api; groups: Group[]; currentUser: User | null }) {
  const [tab, setTab] = useState<AnalyticsTab>("overview");
  const [chatFilter, setChatFilter] = useState("");
  const d = date || "";

  const tabsNeedingGroup: AnalyticsTab[] = ["timeline", "clusters"];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold text-glow-purple" style={{fontFamily:"'Share Tech Mono',monospace",color:"var(--neon-purple)"}}>ANALYTICS</h1>
          <p className="text-[rgba(0,200,255,0.45)] text-sm font-mono mt-1">{fmtDate(date)}</p>
        </div>
        {!tabsNeedingGroup.includes(tab) && (
          <select value={chatFilter} onChange={e => setChatFilter(e.target.value)}
            className="rounded-lg bg-[#0a0a1c] border border-[rgba(0,200,255,0.1)] px-3 py-2 text-sm font-mono outline-none focus:border-sky-500">
            <option value="">All groups</option>
            {groups.map(g => <option key={g.chat_id} value={g.chat_id}>{g.chat_title || g.chat_id}</option>)}
          </select>
        )}
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 flex-wrap border-b border-[rgba(0,200,255,0.1)] pb-1">
        {ANALYTIC_TABS.map(({ key, label, highlight }) => (
          <button key={key} onClick={() => setTab(key)}
            className="px-3 py-1.5 rounded-t text-[11px] font-mono tracking-wide transition-all"
            style={tab === key
              ? (highlight
                  ? {background:"rgba(255,51,102,0.08)",border:"1px solid rgba(255,51,102,0.4)",borderBottom:"1px solid #04040a",color:"var(--neon-red)",boxShadow:"0 0 8px rgba(255,51,102,0.2)"}
                  : {background:"rgba(0,200,255,0.06)",border:"1px solid rgba(0,200,255,0.4)",borderBottom:"1px solid #04040a",color:"white",boxShadow:"0 0 8px rgba(0,200,255,0.15)"})
              : (highlight
                  ? {color:"rgba(255,51,102,0.6)"}
                  : {color:"rgba(0,200,255,0.3)"})
            }>{label}</button>
        ))}
      </div>

      {tab === "overview"   && <OverviewTab date={d} api={api} />}
      {tab === "edit"       && <EditTab date={d} api={api} chatId={chatFilter || undefined} />}
      {tab === "delete"     && <DeleteTab date={d} api={api} chatId={chatFilter || undefined} />}
      {tab === "media"      && <MediaTab date={d} api={api} chatId={chatFilter || undefined} />}
      {tab === "forwards"   && <ForwardsTab date={d} api={api} chatId={chatFilter || undefined} />}
      {tab === "links"      && <LinksTab date={d} api={api} chatId={chatFilter || undefined} />}
      {tab === "mentions"   && <MentionsTab date={d} api={api} chatId={chatFilter || undefined} />}
      {tab === "keywords"   && <KeywordsTab date={d} api={api} chatId={chatFilter || undefined} role={currentUser?.role || "user"} />}
      {tab === "phrases"    && <PhrasesTab date={d} api={api} chatId={chatFilter || undefined} />}
      {tab === "timeline"   && <TimelineTab date={d} api={api} groups={groups} />}
      {tab === "suspicious" && <SuspiciousTab date={d} api={api} chatId={chatFilter || undefined} />}
      {tab === "clusters"    && <ClustersTab date={d} api={api} groups={groups} />}
      {tab === "deleted_feed" && <DeletedFeedTab date={d} api={api} groups={groups} />}
    </div>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function Home() {
  // useState null boshlanadi (SSR/client bir xil) → hydration error yo'q
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [apiInstance, setApiInstance] = useState<Api | null>(null);
  const [sessionRestored, setSessionRestored] = useState(false);

  // Client da mount bo'lgandan keyin localStorage dan session tiklaymiz
  useEffect(() => {
    const session = restoreSession();
    if (session) {
      setCurrentUser(session.user);
      setApiInstance(() => session.api);
    }
    setSessionRestored(true);
  }, []);
  const [days, setDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventRow | null>(null);
  const [page, setPage] = useState<"main" | "groups" | "group" | "details" | "analytics">("main");
  const [filterType, setFilterType] = useState("all");
  const [search, setSearch] = useState("");

  // Token auto-refresh — har daqiqa tekshiradi, 5 daqiqa qolsa yangilaydi
  useTokenRefresh(!!currentUser, () => {
    setCurrentUser(null);
    setApiInstance(() => null);
  });

  const handleLogin = useCallback((user: User, api: Api) => {
    setCurrentUser(user);
    setApiInstance(() => api);
  }, []);

  const handleLogout = () => {
    clearToken();
    setCurrentUser(null);
    setApiInstance(() => null);
    setPage("main");
    setDays([]); setSelectedDay(null); setGroups([]); setEvents([]);
  };

  useEffect(() => {
    if (!apiInstance) return;
    apiInstance.get("/days")
      .then(res => {
        const d: string[] = res.data.days || [];
        setDays(d);
        if (d.length) setSelectedDay(d[0]);
      })
      .catch(() => {});
  }, [apiInstance]);

  useEffect(() => {
    if (!selectedDay || !apiInstance) return;
    const load = () => {
      apiInstance.get(`/day-summary?date=${selectedDay}`)
        .then(r => setDaySummary(r.data)).catch(() => {});
      apiInstance.get(`/groups-summary?date=${selectedDay}`)
        .then(r => setGroups(r.data || [])).catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [selectedDay, apiInstance]);

  useEffect(() => {
    if (!selectedDay || !selectedGroup || !apiInstance) return;
    const load = () => {
      apiInstance.get(`/events?date=${selectedDay}&chat_id=${selectedGroup.chat_id}`)
        .then(r => {
          const rows: EventRow[] = r.data || [];
          setEvents(rows);
          setSelectedEvent(cur => cur ? rows.find(e => e.id === cur.id) || cur : cur);
        })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [selectedDay, selectedGroup, apiInstance]);

  const monthDays = buildMonthDays(selectedDay || new Date().toISOString().slice(0, 10), days);

  const filteredEvents = useMemo(() => {
    let rows = events;
    if (filterType !== "all") rows = rows.filter(e => e.event_type === filterType);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(e =>
        [e.text, e.old_text, e.new_text, e.deleted_original_text, e.sender_name, e.sender_username, String(e.message_id || "")]
          .filter(Boolean).join(" ").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [events, filterType, search]);

  const canAnalytic = currentUser?.role === "admin" || currentUser?.role === "analytic";
  const mediaUrl = (selectedEvent?.media_path || selectedEvent?.deleted_original_media_path)
    ? `${API}/${(selectedEvent?.media_path || selectedEvent?.deleted_original_media_path || "").replaceAll("\\", "/")}`
    : null;
  const mediaType = selectedEvent?.media_type || selectedEvent?.deleted_original_media_type;

  // Hali session tekshirilmagan — blank sahifa (hydration bilan muammo bo'lmasin)
  if (!sessionRestored) return null;

  if (!currentUser || !apiInstance) return (
    <ToastProvider><LoginPage onLogin={handleLogin} /></ToastProvider>
  );

  return (
    <ToastProvider>
    <main className="min-h-screen bg-[#04040a] text-white relative z-10" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');
        * { box-sizing: border-box; }
        :root {
          --neon-green: #00ff88;
          --neon-blue: #00c8ff;
          --neon-purple: #b060ff;
          --neon-red: #ff3366;
          --neon-amber: #ffaa00;
          --neon-cyan: #00ffe5;
          --bg-base: #04040a;
          --bg-card: rgba(8,8,18,0.95);
          --bg-card2: rgba(12,12,24,0.9);
        }

        /* ── Grid background ── */
        body::before {
          content: '';
          position: fixed; inset: 0; z-index: 0; pointer-events: none;
          background-image:
            linear-gradient(rgba(0,255,136,0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,255,136,0.025) 1px, transparent 1px);
          background-size: 44px 44px;
        }

        /* ── Scanline ── */
        body::after {
          content: '';
          position: fixed; left: 0; width: 100%; height: 3px; z-index: 9998; pointer-events: none;
          background: linear-gradient(transparent, rgba(0,255,136,0.06), transparent);
          animation: scan 6s linear infinite;
        }
        @keyframes scan { 0% { top: -5% } 100% { top: 105% } }

        /* ── Neon glow helpers ── */
        .glow-green  { box-shadow: 0 0 6px rgba(0,255,136,0.35), 0 0 20px rgba(0,255,136,0.12), inset 0 0 6px rgba(0,255,136,0.04); }
        .glow-blue   { box-shadow: 0 0 6px rgba(0,200,255,0.35), 0 0 20px rgba(0,200,255,0.12), inset 0 0 6px rgba(0,200,255,0.04); }
        .glow-purple { box-shadow: 0 0 6px rgba(176,96,255,0.35), 0 0 20px rgba(176,96,255,0.12), inset 0 0 6px rgba(176,96,255,0.04); }
        .glow-red    { box-shadow: 0 0 6px rgba(255,51,102,0.35), 0 0 20px rgba(255,51,102,0.12); }
        .glow-amber  { box-shadow: 0 0 6px rgba(255,170,0,0.35), 0 0 20px rgba(255,170,0,0.12); }

        /* ── Neon text glow ── */
        .text-glow-green  { text-shadow: 0 0 8px rgba(0,255,136,0.7), 0 0 20px rgba(0,255,136,0.3); }
        .text-glow-blue   { text-shadow: 0 0 8px rgba(0,200,255,0.7), 0 0 20px rgba(0,200,255,0.3); }
        .text-glow-purple { text-shadow: 0 0 8px rgba(176,96,255,0.7), 0 0 20px rgba(176,96,255,0.3); }
        .text-glow-red    { text-shadow: 0 0 8px rgba(255,51,102,0.7), 0 0 20px rgba(255,51,102,0.3); }
        .text-glow-amber  { text-shadow: 0 0 8px rgba(255,170,0,0.7), 0 0 20px rgba(255,170,0,0.3); }

        /* ── Neon borders ── */
        .border-neon-green  { border-color: rgba(0,255,136,0.35) !important; }
        .border-neon-blue   { border-color: rgba(0,200,255,0.35) !important; }
        .border-neon-purple { border-color: rgba(176,96,255,0.35) !important; }
        .border-neon-red    { border-color: rgba(255,51,102,0.35) !important; }
        .border-neon-amber  { border-color: rgba(255,170,0,0.35) !important; }

        /* ── Top accent line on cards ── */
        .card-accent-green::before  { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,var(--neon-green),transparent); }
        .card-accent-blue::before   { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,var(--neon-blue),transparent); }
        .card-accent-purple::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,var(--neon-purple),transparent); }
        .card-accent-red::before    { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,var(--neon-red),transparent); }
        .card-accent-amber::before  { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,var(--neon-amber),transparent); }

        /* ── Animations ── */
        @keyframes slideIn  { from { opacity:0; transform:translateX(24px); } to { opacity:1; transform:translateX(0); } }
        @keyframes fadeUp   { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        @keyframes neonPulse { 0%,100%{opacity:1} 50%{opacity:0.6} }
        @keyframes borderGlow { 0%,100%{box-shadow:0 0 6px rgba(0,200,255,0.3),0 0 20px rgba(0,200,255,0.1)} 50%{box-shadow:0 0 12px rgba(0,200,255,0.6),0 0 40px rgba(0,200,255,0.2)} }

        .animate-slideIn   { animation: slideIn 0.2s ease-out forwards; }
        .animate-fadeUp    { animation: fadeUp 0.3s ease-out forwards; }
        .animate-neonPulse { animation: neonPulse 2s ease-in-out infinite; }

        /* ── Neon input focus ── */
        .neon-input:focus { border-color: rgba(0,200,255,0.6) !important; box-shadow: 0 0 0 1px rgba(0,200,255,0.2), 0 0 16px rgba(0,200,255,0.1) !important; }
        .neon-input-green:focus { border-color: rgba(0,255,136,0.6) !important; box-shadow: 0 0 0 1px rgba(0,255,136,0.2), 0 0 16px rgba(0,255,136,0.1) !important; }

        /* ── Neon button ── */
        .btn-neon-blue { animation: borderGlow 3s ease infinite; }
        .btn-neon-blue:hover { background: rgba(0,200,255,0.15) !important; box-shadow: 0 0 20px rgba(0,200,255,0.3), 0 0 40px rgba(0,200,255,0.1) !important; }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 3px; height: 3px; }
        ::-webkit-scrollbar-track { background: #04040a; }
        ::-webkit-scrollbar-thumb { background: rgba(0,200,255,0.2); border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(0,200,255,0.4); }

        /* ── Clamp ── */
        .line-clamp-2 { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .line-clamp-1 { display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden; }

        /* ════════════════════════════════════════════
           TELEGRAM BUBBLE STYLES
           ════════════════════════════════════════════ */
        .tg-chat { display:flex; flex-direction:column; gap:2px; padding:8px 0; }

        /* Row */
        .tg-row { display:flex; align-items:flex-end; gap:6px; }
        .tg-row.tg-out { flex-direction:row-reverse; }
        .tg-avatar-spacer { width:32px; flex-shrink:0; }

        /* Avatar */
        .tg-avatar {
          width:32px; height:32px; border-radius:50%; flex-shrink:0;
          display:flex; align-items:center; justify-content:center;
          font-size:13px; font-weight:700; color:#fff; text-transform:uppercase;
          box-shadow: 0 0 8px rgba(0,0,0,0.4);
        }

        /* Bubble base */
        .tg-bubble {
          max-width:72%; padding:7px 12px 5px;
          font-size:14px; line-height:1.55; word-break:break-word;
          position:relative; transition:all 0.15s;
          font-family: 'Inter', -apple-system, sans-serif;
        }

        /* Incoming bubble */
        .tg-bubble.tg-in {
          background:#182533;
          border-radius:4px 18px 18px 18px;
          color:#e8f4ff;
        }
        /* Incoming tail */
        .tg-bubble.tg-in::before {
          content:''; position:absolute; bottom:0; left:-7px;
          width:10px; height:14px; background:#182533;
          clip-path:polygon(100% 0,100% 100%,0 100%);
        }

        /* Outgoing bubble */
        .tg-bubble.tg-out {
          background:#2b5278;
          border-radius:18px 4px 18px 18px;
          color:#fff;
        }
        .tg-bubble.tg-out::before {
          content:''; position:absolute; bottom:0; right:-7px;
          width:10px; height:14px; background:#2b5278;
          clip-path:polygon(0 0,0 100%,100% 100%);
        }

        /* Deleted overlay */
        .tg-bubble.tg-deleted {
          background:#1a1a2a !important;
          border:1px solid rgba(255,51,102,0.3);
          opacity:0.75;
        }
        .tg-bubble.tg-deleted::before { background:#1a1a2a !important; }
        .tg-deleted-text { text-decoration:line-through; color:rgba(255,100,120,0.7); }

        /* Sender name */
        .tg-sender { font-size:13px; font-weight:600; margin-bottom:3px; }

        /* Message text */
        .tg-text { font-size:14px; line-height:1.55; color:#e8f4ff; }
        .tg-text a { color:#4fafe3; }

        /* Meta (time + status) */
        .tg-meta {
          display:flex; align-items:center; justify-content:flex-end;
          gap:4px; margin-top:3px; float:right; margin-left:8px;
        }
        .tg-time { font-size:11px; color:rgba(255,255,255,0.4); }
        .tg-edited-mark { font-size:11px; color:rgba(255,170,0,0.7); }

        /* Forwarded bar */
        .tg-fwd {
          border-left:3px solid #4fafe3;
          padding:2px 8px; margin-bottom:5px;
          font-size:12px; color:#4fafe3;
          border-radius:0 4px 4px 0;
        }
        .tg-fwd-from { font-weight:600; }

        /* Edit diff inside bubble */
        .tg-diff-old {
          background:rgba(255,51,102,0.1); border-left:3px solid rgba(255,51,102,0.6);
          padding:5px 9px; border-radius:0 6px 6px 0; margin-bottom:4px;
          font-size:13px; color:rgba(255,120,140,0.85);
        }
        .tg-diff-new {
          background:rgba(0,255,136,0.08); border-left:3px solid rgba(0,255,136,0.5);
          padding:5px 9px; border-radius:0 6px 6px 0;
          font-size:13px; color:rgba(100,255,180,0.9);
        }
        .tg-diff-label {
          font-size:10px; font-weight:700; letter-spacing:0.1em;
          opacity:0.6; margin-bottom:3px; font-family:monospace;
        }

        /* Media inside bubble */
        .tg-media {
          border-radius:10px; overflow:hidden; margin-bottom:4px;
          max-width:240px; min-height:60px;
          background:rgba(0,0,0,0.3);
          display:flex; align-items:center; justify-content:center;
        }
        .tg-media img, .tg-media video { width:100%; height:auto; display:block; }
        .tg-media-placeholder {
          width:220px; height:120px; display:flex; flex-direction:column;
          align-items:center; justify-content:center; gap:6px;
          color:rgba(255,255,255,0.3); font-size:12px; font-family:monospace;
        }

        /* System message (missing IDs, etc) */
        .tg-system {
          align-self:center; background:rgba(15,25,40,0.8);
          border:1px solid rgba(255,170,0,0.2); border-radius:12px;
          padding:4px 14px; font-size:12px; font-family:monospace;
          color:rgba(255,170,0,0.7); margin:4px 0; text-align:center;
        }

        /* Keyword highlight in bubble */
        .tg-kw-mark { background:rgba(255,51,102,0.25); color:#ff8fa3; border-radius:3px; padding:0 2px; }

        /* Sticker bubble — transparent bg */
        .tg-bubble.tg-sticker { background:transparent !important; padding:4px; }
        .tg-bubble.tg-sticker::before { display:none; }

        /* Voice/audio */
        .tg-voice { display:flex; align-items:center; gap:8px; min-width:180px; }
        .tg-voice-icon { width:36px; height:36px; border-radius:50%; background:rgba(79,175,227,0.2); display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0; }
        .tg-voice-bar { flex:1; height:2px; background:rgba(79,175,227,0.2); border-radius:1px; position:relative; }
        .tg-voice-bar::after { content:''; position:absolute; left:0; top:0; width:40%; height:100%; background:#4fafe3; border-radius:1px; }

        /* ── Active nav tab ── */
        .nav-active { background: rgba(0,200,255,0.08) !important; border-color: rgba(0,200,255,0.35) !important; color: #00c8ff !important; box-shadow: 0 0 8px rgba(0,200,255,0.2); }
        .nav-analytics-active { background: rgba(176,96,255,0.08) !important; border-color: rgba(176,96,255,0.35) !important; color: #b060ff !important; box-shadow: 0 0 8px rgba(176,96,255,0.2); }
      `}</style>

      {/* Header */}
      <header className="sticky top-0 z-50 px-6 py-3 flex items-center gap-4 backdrop-blur-md" style={{background:"rgba(4,4,10,0.92)",borderBottom:"1px solid rgba(0,200,255,0.12)",boxShadow:"0 1px 0 rgba(0,200,255,0.06),0 4px 20px rgba(0,0,0,0.6)"}}>
        {/* Breadcrumb navigation */}
        <div className="flex items-center gap-1 text-[11px] font-mono shrink-0">
          <button onClick={() => setPage("main")} style={{color: page==="main" ? "var(--neon-blue)" : "rgba(0,200,255,0.4)"}}>OVERVIEW</button>
          {(page==="groups"||page==="group"||page==="details") && (<>
            <span style={{color:"rgba(0,200,255,0.2)"}}>›</span>
            <button onClick={() => setPage("groups")} style={{color: page==="groups" ? "var(--neon-blue)" : "rgba(0,200,255,0.4)"}}>GROUPS</button>
          </>)}
          {(page==="group"||page==="details") && selectedGroup && (<>
            <span style={{color:"rgba(0,200,255,0.2)"}}>›</span>
            <button onClick={() => { setPage("group"); setFilterType("all"); }} className="max-w-[120px] truncate" style={{color: page==="group" ? "var(--neon-blue)" : "rgba(0,200,255,0.4)"}}>
              {selectedGroup.chat_title || selectedGroup.chat_id}
            </button>
          </>)}
          {page==="details" && selectedEvent && (<>
            <span style={{color:"rgba(0,200,255,0.2)"}}>›</span>
            <span style={{color:"rgba(255,255,255,0.4)"}}>#{selectedEvent.message_id}</span>
          </>)}
          {page==="analytics" && (<>
            <span style={{color:"rgba(176,96,255,0.3)"}}>›</span>
            <span style={{color:"var(--neon-purple)"}}>ANALYTICS</span>
          </>)}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full animate-neonPulse" style={{background:"var(--neon-green)",boxShadow:"0 0 8px var(--neon-green)"}} />
          <span className="text-[10px] tracking-[0.25em] text-[rgba(0,200,255,0.45)]">TG MONITOR</span>
        </div>
        <nav className="flex items-center gap-1 ml-2">
          {(["main", "groups"] as const).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={`px-3 py-1.5 rounded text-[11px] font-mono transition-colors ${page === p ? "bg-[rgba(0,200,255,0.06)] text-white" : "text-[rgba(0,200,255,0.45)] hover:text-[rgba(255,255,255,0.75)]"}`}>
              {p === "main" ? "OVERVIEW" : "GROUPS"}
            </button>
          ))}
          {canAnalytic && (
            <button onClick={() => setPage("analytics")}
              className={`px-3 py-1.5 rounded text-[11px] font-mono transition-colors ${page === "analytics" ? "bg-purple-900/50 text-purple-300" : "text-[rgba(0,200,255,0.45)] hover:text-[rgba(255,255,255,0.75)]"}`}>
              ANALYTICS
            </button>
          )}
        </nav>

        {/* Day selector */}
        <div className="flex items-center gap-2 ml-2">
          <span className="text-[10px] text-[rgba(0,200,255,0.3)] font-mono">DATE:</span>
          <select value={selectedDay || ""} onChange={e => setSelectedDay(e.target.value)}
            className="rounded bg-[#0a0a1c] border border-[rgba(0,200,255,0.1)] px-2 py-1 text-[11px] font-mono outline-none focus:border-sky-500">
            {days.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <RoleBadge role={currentUser.role} />
          <span className="text-xs font-mono text-[rgba(0,200,255,0.45)]">{currentUser.username}</span>
          <button onClick={handleLogout} className="text-[11px] font-mono text-[rgba(0,200,255,0.3)] hover:text-rose-400 transition-colors">LOGOUT</button>
        </div>
      </header>

      <div className="p-6">
        {/* ── ANALYTICS ── */}
        {page === "analytics" && canAnalytic && (
          <AnalyticsPage date={selectedDay} api={apiInstance} groups={groups} currentUser={currentUser} />
        )}

        {/* ── MAIN ── */}
        {page === "main" && (
          <div className="max-w-5xl mx-auto space-y-6">
            <h1 className="text-3xl font-bold text-glow-blue" style={{fontFamily:"'Share Tech Mono',monospace",color:"var(--neon-blue)"}}>OVERVIEW</h1>
            <div className="grid grid-cols-2 gap-6">
              {/* Calendar */}
              <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-6">
                <div className="text-[10px] font-mono tracking-[0.2em] text-[rgba(0,200,255,0.3)] mb-5">
                  {selectedDay ? new Date(selectedDay).toLocaleString("en-US", { month: "long", year: "numeric" }).toUpperCase() : "CALENDAR"}
                </div>
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => <div key={d} className="text-center text-[10px] text-[rgba(0,200,255,0.2)] font-mono py-1">{d}</div>)}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {monthDays.map((d, i) => (
                    <button key={i} disabled={d.blank || !d.hasLogs} onClick={() => d.hasLogs && setSelectedDay(d.date)}
                      className={`h-9 rounded text-xs font-mono transition-all ${d.blank ? "invisible" : d.date === selectedDay ? "font-bold text-[#04040a]" : d.hasLogs ? "bg-[rgba(0,200,255,0.06)] text-zinc-200 hover:bg-[rgba(0,200,255,0.08)]" : "text-[rgba(0,200,255,0.2)] cursor-default"}`}>
                      {d.blank ? "" : d.day}
                    </button>
                  ))}
                </div>
              </div>

              {/* Day summary */}
              <div className="rounded-xl border border-[rgba(0,200,255,0.1)] bg-[#08081a] p-6 space-y-5">
                <div className="text-[10px] font-mono tracking-[0.2em] text-[rgba(0,200,255,0.3)]">DAY SUMMARY · {fmtDate(selectedDay).toUpperCase()}</div>
                <div className="grid grid-cols-2 gap-3">
                  <StatCard label="TOTAL" value={daySummary?.total || 0} accent="border-[rgba(0,200,255,0.15)]" />
                  <StatCard label="EDITED" value={daySummary?.edited || 0} accent="border-neon-amber glow-amber card-accent-amber" />
                  <StatCard label="DELETED" value={daySummary?.deleted || 0} accent="border-neon-red glow-red card-accent-red" />
                  <StatCard label="MISSING" value={daySummary?.missing || 0} accent="border-neon-purple glow-purple card-accent-purple" />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setPage("groups")} className="flex-1 py-3 rounded-lg transition-all text-sm font-bold tracking-widest btn-neon-blue" style={{background:"rgba(0,200,255,0.08)",border:"1px solid rgba(0,200,255,0.35)",color:"var(--neon-blue)"}}>VIEW GROUPS →</button>
                  {canAnalytic && (
                    <button onClick={() => setPage("analytics")} className="flex-1 py-3 rounded-lg transition-all text-sm font-bold tracking-widest" style={{background:"rgba(176,96,255,0.08)",border:"1px solid rgba(176,96,255,0.35)",color:"var(--neon-purple)",boxShadow:"0 0 8px rgba(176,96,255,0.15)"}}>ANALYTICS →</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── GROUPS ── */}
        {page === "groups" && (
          <div className="max-w-6xl mx-auto space-y-6">
            <h1 className="text-3xl font-bold text-glow-blue" style={{fontFamily:"'Share Tech Mono',monospace",color:"var(--neon-blue)"}}>GROUPS</h1>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {groups.map(g => <GroupCard key={g.chat_id} group={g} onClick={() => { setSelectedGroup(g); setPage("group"); }} />)}
              {!groups.length && <div className="col-span-4"><Empty text="No groups found for this day" /></div>}
            </div>
          </div>
        )}

        {/* ── GROUP EVENTS — Telegram Chat View ── */}
        {page === "group" && selectedGroup && (
          <div className="max-w-3xl mx-auto flex flex-col h-[calc(100vh-80px)]">

            {/* ── Chat header (Telegram style) ── */}
            <div className="flex items-center gap-3 px-4 py-3 sticky top-0 z-10 rounded-t-xl"
              style={{background:"rgba(14,21,33,0.97)",borderBottom:"1px solid rgba(0,200,255,0.1)",backdropFilter:"blur(10px)"}}>
              {/* Avatar */}
              <div className="w-10 h-10 rounded-full flex items-center justify-center text-base font-bold shrink-0"
                style={{background:avatarColor(selectedGroup.chat_title || "G")}}>
                {(selectedGroup.chat_title || "G")[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm truncate">{selectedGroup.chat_title || selectedGroup.chat_id}</div>
                <div className="text-[11px] font-mono" style={{color:"rgba(0,200,255,0.4)"}}>
                  {events.length} messages · {fmtDate(selectedDay)}
                </div>
              </div>
              {/* Filter tabs */}
              <div className="flex gap-1">
                {[
                  { key: "all",             short: "All" },
                  { key: "new_message",     short: "New" },
                  { key: "edited_message",  short: "Edit" },
                  { key: "deleted_message", short: "Del" },
                ].map(({ key, short }) => (
                  <button key={key} onClick={() => setFilterType(key)}
                    className="px-2.5 py-1 rounded-full text-[10px] font-mono font-bold transition-all"
                    style={filterType === key
                      ? {background: key === "deleted_message" ? "rgba(255,51,102,0.2)" : key === "edited_message" ? "rgba(255,170,0,0.2)" : "rgba(0,200,255,0.15)", color: key === "deleted_message" ? "var(--neon-red)" : key === "edited_message" ? "var(--neon-amber)" : "var(--neon-blue)", border: `1px solid ${key === "deleted_message" ? "rgba(255,51,102,0.4)" : key === "edited_message" ? "rgba(255,170,0,0.4)" : "rgba(0,200,255,0.4)"}`}
                      : {background:"rgba(255,255,255,0.04)",color:"rgba(255,255,255,0.3)",border:"1px solid rgba(255,255,255,0.08)"}
                    }>{short}</button>
                ))}
              </div>
            </div>

            {/* ── Search bar ── */}
            <div className="px-4 py-2" style={{background:"rgba(14,21,33,0.95)"}}>
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="🔍 Qidirish..."
                className="w-full rounded-full px-4 py-2 text-sm outline-none transition-all"
                style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(0,200,255,0.1)",color:"rgba(255,255,255,0.8)",fontFamily:"Inter,-apple-system,sans-serif"}} />
            </div>

            {/* ── Messages list — scrollable ── */}
            <div id="chat-scroll" className="flex-1 overflow-y-auto px-4 py-3 space-y-1"
              ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
              style={{background:"#0e1621",backgroundImage:"radial-gradient(ellipse at 20% 50%, rgba(0,200,255,0.015) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgba(176,96,255,0.015) 0%, transparent 60%)"}}>

              {/* Date badge */}
              {filteredEvents.length > 0 && (
                <div className="flex justify-center my-3">
                  <span className="text-[11px] font-mono px-3 py-1 rounded-full"
                    style={{background:"rgba(0,0,0,0.4)",color:"rgba(255,255,255,0.35)",border:"1px solid rgba(255,255,255,0.06)"}}>
                    {fmtDate(selectedDay)}
                  </span>
                </div>
              )}

              <div className="tg-chat">
                {[...filteredEvents].reverse().map((e, i, arr) => {
                  // Soat separator — oldingi (vaqt bo'yicha keyingi) xabar bilan solishtirish
                  const prevEvent = arr[i - 1];
                  const showTimeSep = prevEvent &&
                    e.created_at?.slice(11,13) !== prevEvent.created_at?.slice(11,13);

                  return (
                    <div key={e.id}>
                      {showTimeSep && (
                        <div className="flex justify-center my-2">
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                            style={{background:"rgba(0,0,0,0.3)",color:"rgba(255,255,255,0.2)"}}>
                            {e.created_at?.slice(11,16)}
                          </span>
                        </div>
                      )}
                      <TelegramBubble
                        event={e}
                        apiBase={API}
                        onClick={() => { setSelectedEvent(e); setPage("details"); }}
                      />
                    </div>
                  );
                })}
              </div>

              {!filteredEvents.length && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                  <div className="text-4xl opacity-30">💬</div>
                  <div className="text-xs font-mono" style={{color:"rgba(255,255,255,0.2)"}}>Xabar topilmadi</div>
                </div>
              )}
            </div>

            {/* ── Bottom info bar ── */}
            <div className="flex items-center justify-between px-4 py-2 rounded-b-xl"
              style={{background:"rgba(14,21,33,0.97)",borderTop:"1px solid rgba(0,200,255,0.08)"}}>
              <div className="flex gap-4 text-[10px] font-mono">
                <span style={{color:"var(--neon-green)"}}>{events.filter(e=>e.event_type==="new_message").length} new</span>
                <span style={{color:"var(--neon-amber)"}}>{events.filter(e=>e.event_type==="edited_message").length} edited</span>
                <span style={{color:"var(--neon-red)"}}>{events.filter(e=>e.event_type==="deleted_message").length} deleted</span>
                {events.filter(e=>e.event_type==="missing_ids").length > 0 && (
                  <span style={{color:"var(--neon-purple)"}}>{events.filter(e=>e.event_type==="missing_ids").length} missing</span>
                )}
              </div>
              <div className="text-[10px] font-mono" style={{color:"rgba(0,200,255,0.3)"}}>
                Auto-refresh 5s
              </div>
            </div>
          </div>
        )}

        {/* ── EVENT DETAILS — Telegram notification bot style ── */}
        {page === "details" && selectedEvent && (
          <div className="max-w-2xl mx-auto space-y-3">

            {/* ── Notification header (bot message style) ── */}
            <div className="rounded-2xl overflow-hidden" style={{background:"#182533",border:"1px solid rgba(0,200,255,0.12)"}}>

              {/* Bot header */}
              <div className="flex items-center gap-3 px-4 py-3" style={{background:"rgba(0,0,0,0.3)",borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                  style={{background:"linear-gradient(135deg,#1a3a5c,#4fafe3)"}}>🤖</div>
                <div className="flex-1">
                  <div className="text-sm font-semibold" style={{color:"#4fafe3"}}>Monitor Bot</div>
                  <div className="text-[11px]" style={{color:"rgba(255,255,255,0.3)"}}>
                    {selectedGroup?.chat_title} · {selectedEvent.created_at?.slice(11,16)}
                  </div>
                </div>
                {/* Event type */}
                <span className="text-[10px] font-mono font-bold px-2 py-1 rounded-full"
                  style={{
                    background: selectedEvent.event_type === "deleted_message" ? "rgba(255,51,102,0.15)" : selectedEvent.event_type === "edited_message" ? "rgba(255,170,0,0.15)" : "rgba(0,255,136,0.1)",
                    color: selectedEvent.event_type === "deleted_message" ? "var(--neon-red)" : selectedEvent.event_type === "edited_message" ? "var(--neon-amber)" : "var(--neon-green)",
                    border: `1px solid ${selectedEvent.event_type === "deleted_message" ? "rgba(255,51,102,0.35)" : selectedEvent.event_type === "edited_message" ? "rgba(255,170,0,0.35)" : "rgba(0,255,136,0.25)"}`,
                  }}>
                  {selectedEvent.event_type === "deleted_message" ? "✕ DELETED"
                    : selectedEvent.event_type === "edited_message" ? "✎ EDITED"
                    : "● NEW"}
                </span>
              </div>

              {/* Keyword alerts */}
              {selectedEvent.keyword_alerts?.length ? (
                <div className="flex items-center gap-2 px-4 py-2 flex-wrap" style={{background:"rgba(255,51,102,0.06)",borderBottom:"1px solid rgba(255,51,102,0.15)"}}>
                  <span className="text-[10px] font-mono text-rose-400">⚑ KEYWORD:</span>
                  {selectedEvent.keyword_alerts.map(kw => (
                    <span key={kw} className="text-[10px] font-mono px-2 py-0.5 rounded"
                      style={{background:"rgba(255,51,102,0.15)",color:"var(--neon-red)",border:"1px solid rgba(255,51,102,0.3)"}}>
                      {kw.toUpperCase()}
                    </span>
                  ))}
                </div>
              ) : null}

              {/* Notification body */}
              <div className="px-4 py-4 space-y-3" style={{fontFamily:"Inter,-apple-system,sans-serif"}}>

                {/* ── EDITED: Eski + Yangi ── */}
                {selectedEvent.event_type === "edited_message" && (
                  <>
                    <div className="text-sm font-semibold" style={{color:"rgba(255,255,255,0.9)"}}>
                      Сообщение отредактировано
                    </div>
                    {/* Sender */}
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                        style={{background:avatarColor(selectedEvent.sender_name||"U")}}>
                        {(selectedEvent.sender_name||"?")[0].toUpperCase()}
                      </div>
                      <span className="text-sm font-semibold" style={{color:senderColor(selectedEvent.sender_name||"U")}}>
                        {selectedEvent.sender_name}
                        {selectedEvent.sender_username && <span style={{fontWeight:400,opacity:0.6}}> @{selectedEvent.sender_username}</span>}
                      </span>
                    </div>
                    {/* Old text */}
                    {selectedEvent.old_text && (
                      <div>
                        <div className="text-[11px] font-mono mb-1" style={{color:"rgba(255,51,102,0.7)"}}>Старое:</div>
                        <div className="tg-diff-old">{selectedEvent.old_text}</div>
                      </div>
                    )}
                    {/* New text */}
                    {selectedEvent.new_text && (
                      <div>
                        <div className="text-[11px] font-mono mb-1" style={{color:"rgba(0,255,136,0.7)"}}>Новое:</div>
                        <div className="tg-diff-new">{selectedEvent.new_text}</div>
                      </div>
                    )}
                    {/* Media */}
                    {mediaUrl && (
                      <TgMedia mediaPath={mediaUrl.replace(API+"/","")} mediaType={mediaType} API_BASE={API} />
                    )}
                    <div className="text-xs" style={{color:"rgba(0,200,255,0.4)"}}>
                      Чат: {selectedGroup?.chat_title}
                    </div>
                  </>
                )}

                {/* ── DELETED ── */}
                {selectedEvent.event_type === "deleted_message" && (
                  <>
                    <div className="text-sm font-semibold" style={{color:"rgba(255,255,255,0.9)"}}>
                      Сообщение удалено
                    </div>
                    {/* Original sender */}
                    {(selectedEvent.deleted_original_sender_name || selectedEvent.sender_name) && (
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                          style={{background:avatarColor(selectedEvent.deleted_original_sender_name||selectedEvent.sender_name||"U")}}>
                          {(selectedEvent.deleted_original_sender_name||selectedEvent.sender_name||"?")[0].toUpperCase()}
                        </div>
                        <span className="text-sm font-semibold" style={{color:senderColor(selectedEvent.deleted_original_sender_name||selectedEvent.sender_name||"U")}}>
                          {selectedEvent.deleted_original_sender_name||selectedEvent.sender_name}
                          {(selectedEvent.deleted_original_sender_username||selectedEvent.sender_username) && (
                            <span style={{fontWeight:400,opacity:0.6}}> @{selectedEvent.deleted_original_sender_username||selectedEvent.sender_username}</span>
                          )}
                        </span>
                      </div>
                    )}
                    {/* Media type label */}
                    {(selectedEvent.deleted_original_media_type || selectedEvent.media_type) && (
                      <div className="text-xs font-mono" style={{color:"rgba(0,200,255,0.5)"}}>
                        Тип: {selectedEvent.deleted_original_media_type || selectedEvent.media_type}
                      </div>
                    )}
                    {/* Original media */}
                    {(selectedEvent.deleted_original_media_path || (mediaUrl && ["photo","gif","video"].includes(mediaType||""))) && (
                      <TgMedia
                        mediaPath={selectedEvent.deleted_original_media_path || mediaUrl?.replace(API+"/","")}
                        mediaType={selectedEvent.deleted_original_media_type || mediaType}
                        API_BASE={API}
                      />
                    )}
                    {/* Original text */}
                    {selectedEvent.deleted_original_text && (
                      <div>
                        <div className="text-[11px] font-mono mb-1" style={{color:"rgba(255,51,102,0.6)"}}>Текст:</div>
                        <div className="text-sm whitespace-pre-wrap" style={{color:"rgba(232,244,255,0.75)",textDecoration:"line-through",textDecorationColor:"rgba(255,51,102,0.4)"}}>
                          <HighlightedText text={selectedEvent.deleted_original_text} keywords={selectedEvent.keyword_alerts} />
                        </div>
                      </div>
                    )}
                    <div className="text-xs" style={{color:"rgba(0,200,255,0.4)"}}>
                      Чат: {selectedGroup?.chat_title}
                    </div>
                  </>
                )}

                {/* ── NEW MESSAGE ── */}
                {selectedEvent.event_type === "new_message" && (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                        style={{background:avatarColor(selectedEvent.sender_name||"U")}}>
                        {(selectedEvent.sender_name||"?")[0].toUpperCase()}
                      </div>
                      <div>
                        <span className="text-sm font-semibold" style={{color:senderColor(selectedEvent.sender_name||"U")}}>
                          {selectedEvent.sender_name}
                        </span>
                        {selectedEvent.sender_username && (
                          <span className="text-xs ml-1" style={{color:"rgba(255,255,255,0.4)"}}>@{selectedEvent.sender_username}</span>
                        )}
                      </div>
                    </div>
                    {/* Forwarded */}
                    {selectedEvent.is_forwarded && (
                      <div className="tg-fwd">
                        Forwarded from <span className="tg-fwd-from">{selectedEvent.forward_from_chat_title || selectedEvent.forward_from_name || "Unknown"}</span>
                      </div>
                    )}
                    {/* Media */}
                    {mediaUrl && <TgMedia mediaPath={mediaUrl.replace(API+"/","")} mediaType={mediaType} API_BASE={API} />}
                    {/* Text */}
                    {selectedEvent.text && (
                      <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{color:"rgba(232,244,255,0.85)"}}>
                        <HighlightedText text={selectedEvent.text} keywords={selectedEvent.keyword_alerts} />
                      </p>
                    )}
                    <div className="text-xs" style={{color:"rgba(0,200,255,0.4)"}}>
                      Чат: {selectedGroup?.chat_title}
                    </div>
                  </>
                )}

                {/* Meta row */}
                <div className="flex items-center justify-between pt-1" style={{borderTop:"1px solid rgba(255,255,255,0.05)"}}>
                  <div className="flex items-center gap-3 text-[11px] font-mono" style={{color:"rgba(255,255,255,0.25)"}}>
                    <span>msg #{selectedEvent.message_id}</span>
                    {(selectedEvent as any).time_to_delete != null && (
                      <span style={{color:"var(--neon-amber)"}}>⏱ {(selectedEvent as any).time_to_delete}s after send</span>
                    )}
                  </div>
                  {selectedEvent.telegram_link && (
                    <a href={selectedEvent.telegram_link} target="_blank"
                      className="text-[11px] font-mono transition-colors"
                      style={{color:"#4fafe3"}}>
                      ↗ Open in Telegram
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
    </ToastProvider>
  );
}