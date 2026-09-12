import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface SystemInfo {
  total_ram_mb: number;
  used_ram_mb: number;
  cpu_usage: number;
}

interface ProcessInfo {
  pid: number;
  name: string;
  memory_mb: number;
  cpu_usage: number;
  protected: boolean;
}

interface FreeRamProgress {
  stage: string;
  label: string;
}

interface FreeRamResult {
  message: string;
  freed_mb: number;
  after_mb: number;
}

interface StartupProgram {
  name: string;
  command: string;
  location: string;
  enabled: boolean;
}

interface TempCategory {
  id: string;
  label: string;
  path: string;
  size_mb: number;
  file_count: number;
}

interface CleanResult {
  freed_mb: number;
  deleted_count: number;
  skipped_count: number;
}

type SortKey = "memory_mb" | "cpu_usage" | "name";
type View = "dashboard" | "processes" | "startup" | "temp";

function Gauge({ label, value, max, unit, displayValue }: { label: string; value: number; max: number; unit: string; displayValue: string }) {
  const pct = Math.min(100, (value / max) * 100);
  const level = pct > 85 ? "critical" : pct > 60 ? "warning" : "normal";

  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="gauge-label">{label}</span>
        <span className="gauge-value">{displayValue} {unit}</span>
      </div>
      <div className="gauge-track">
        <div className={`gauge-fill gauge-fill--${level}`} style={{ width: `${pct}%` }} />
        <div className="gauge-ticks">
          {Array.from({ length: 9 }).map((_, i) => (
            <span key={i} className="gauge-tick" />
          ))}
        </div>
      </div>
    </div>
  );
}

const NAV_ITEMS: { id: View; label: string }[] = [
  { id: "dashboard", label: "Panel general" },
  { id: "processes", label: "Procesos" },
  { id: "startup", label: "Inicio de Windows" },
  { id: "temp", label: "Archivos temporales" },
];

function App() {
  const [view, setView] = useState<View>("dashboard");

  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("memory_mb");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [feedback, setFeedback] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [freeing, setFreeing] = useState(false);
  const [progressSteps, setProgressSteps] = useState<FreeRamProgress[]>([]);

  const [startupPrograms, setStartupPrograms] = useState<StartupProgram[]>([]);
  const [togglingName, setTogglingName] = useState<string | null>(null);

  const [tempCategories, setTempCategories] = useState<TempCategory[]>([]);
  const [scanningTemp, setScanningTemp] = useState(false);
  const [cleaningId, setCleaningId] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      const info = await invoke<SystemInfo>("get_system_info");
      setSysInfo(info);
      const procs = await invoke<ProcessInfo[]>("get_processes");
      setProcesses(procs);
    };

    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    invoke<StartupProgram[]>("get_startup_programs").then(setStartupPrograms);
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 4000);
    return () => clearTimeout(t);
  }, [feedback]);

  const sortedProcesses = useMemo(() => {
    const copy = [...processes];
    copy.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortKey === "name") return a.name.localeCompare(b.name) * dir;
      return (a[sortKey] - b[sortKey]) * dir;
    });
    return copy;
  }, [processes, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (key !== sortKey) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  async function handleKill(p: ProcessInfo) {
    if (p.protected) return;

    const confirmed = window.confirm(`¿Cerrar "${p.name}" (PID ${p.pid})? Esta acción no se puede deshacer.`);
    if (!confirmed) return;

    setKillingPid(p.pid);
    try {
      await invoke("kill_process", { pid: p.pid });
      setFeedback({ type: "success", text: `"${p.name}" fue cerrado correctamente.` });
      setProcesses((prev) => prev.filter((x) => x.pid !== p.pid));
    } catch (err) {
      setFeedback({ type: "error", text: String(err) });
    } finally {
      setKillingPid(null);
    }
  }

  async function handleFreeRam() {
    setFreeing(true);
    setProgressSteps([]);

    const unlisten = await listen<FreeRamProgress>("free-ram-progress", (event) => {
      setProgressSteps((prev) => [...prev, event.payload]);
    });

    try {
      const result = await invoke<FreeRamResult>("free_ram");
      setFeedback({ type: "success", text: `${result.message} Se liberaron ${Math.max(result.freed_mb, 0)} MB.` });
      setSysInfo((prev) => (prev ? { ...prev, used_ram_mb: result.after_mb } : prev));
    } catch (err) {
      setFeedback({ type: "error", text: String(err) });
    } finally {
      unlisten();
      setFreeing(false);
      setTimeout(() => setProgressSteps([]), 2000);
    }
  }

  async function handleToggleStartup(p: StartupProgram) {
    setTogglingName(p.name);
    try {
      await invoke("toggle_startup_program", {
        name: p.name,
        command: p.command,
        location: p.location,
        enable: !p.enabled,
      });
      const updated = await invoke<StartupProgram[]>("get_startup_programs");
      setStartupPrograms(updated);
      setFeedback({
        type: "success",
        text: `"${p.name}" ${!p.enabled ? "activado" : "desactivado"} en el inicio de Windows.`,
      });
    } catch (err) {
      setFeedback({ type: "error", text: String(err) });
    } finally {
      setTogglingName(null);
    }
  }

  async function handleScanTemp() {
    setScanningTemp(true);
    try {
      const categories = await invoke<TempCategory[]>("get_temp_categories");
      setTempCategories(categories);
    } catch (err) {
      setFeedback({ type: "error", text: String(err) });
    } finally {
      setScanningTemp(false);
    }
  }

  async function handleCleanTemp(cat: TempCategory) {
    const confirmed = window.confirm(
      `¿Eliminar ${cat.file_count} archivos temporales en "${cat.label}"? Esta acción no se puede deshacer.`
    );
    if (!confirmed) return;

    setCleaningId(cat.id);
    try {
      const result = await invoke<CleanResult>("clean_temp_category", { path: cat.path });
      setFeedback({
        type: "success",
        text: `${cat.label}: se liberaron ${result.freed_mb} MB (${result.deleted_count} archivos borrados${result.skipped_count > 0 ? `, ${result.skipped_count} omitidos por estar en uso` : ""}).`,
      });
      handleScanTemp();
    } catch (err) {
      setFeedback({ type: "error", text: String(err) });
    } finally {
      setCleaningId(null);
    }
  }

  const ramUsedGb = sysInfo ? (sysInfo.used_ram_mb / 1024).toFixed(1) : "—";
  const ramTotalGb = sysInfo ? (sysInfo.total_ram_mb / 1024).toFixed(1) : "—";

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="topbar-mark" />
          <span className="sidebar-brand-text">AppOptimización</span>
        </div>
        <nav className="nav-list">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "nav-item--active" : ""}`}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" /> monitoreando en vivo
        </div>
      </aside>

      <main className="content">
        {feedback && (
          <div className={`feedback feedback--${feedback.type}`}>{feedback.text}</div>
        )}

        {view === "dashboard" && (
          <>
            <h2 className="view-title">Panel general</h2>
            <section className="panel panel--gauges">
              <Gauge
                label="MEMORIA"
                value={sysInfo?.used_ram_mb ?? 0}
                max={sysInfo?.total_ram_mb ?? 1}
                unit={`GB / ${ramTotalGb} GB`}
                displayValue={ramUsedGb}
              />
              <Gauge
                label="PROCESADOR"
                value={sysInfo?.cpu_usage ?? 0}
                max={100}
                unit=""
                displayValue={sysInfo ? sysInfo.cpu_usage.toFixed(1) + "%" : "—"}
              />
            </section>

            <div className="free-ram-block">
              <button className="btn-free-ram" onClick={handleFreeRam} disabled={freeing}>
                {freeing && <span className="spinner" />}
                {freeing ? "Optimizando memoria..." : "Liberar RAM"}
              </button>

              {progressSteps.length > 0 && (
                <div className="progress-console">
                  {progressSteps.map((step, i) => (
                    <div
                      key={i}
                      className={`progress-line ${step.stage === "done" ? "progress-line--done" : ""}`}
                    >
                      <span className="progress-marker">{step.stage === "done" ? "✓" : ">"}</span>
                      {step.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {view === "processes" && (
          <>
            <h2 className="view-title">Procesos activos</h2>
            <section className="panel panel--table">
              <div className="panel-head">
                <h2>Procesos activos</h2>
                <span className="panel-subtext">{processes.length} en ejecución · top 20 por consumo</span>
              </div>
              <table className="process-table">
                <thead>
                  <tr>
                    <th className="col-pid">PID</th>
                    <th className="col-name sortable" onClick={() => handleSort("name")}>
                      Nombre{sortIndicator("name")}
                    </th>
                    <th className="col-num sortable" onClick={() => handleSort("memory_mb")}>
                      RAM (MB){sortIndicator("memory_mb")}
                    </th>
                    <th className="col-num sortable" onClick={() => handleSort("cpu_usage")}>
                      CPU %{sortIndicator("cpu_usage")}
                    </th>
                    <th className="col-action"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProcesses.map((p) => {
                    const hot = p.memory_mb > 1000 || p.cpu_usage > 50;
                    const warm = !hot && (p.memory_mb > 400 || p.cpu_usage > 20);
                    const rowClass = hot ? "row-critical" : warm ? "row-warning" : "";
                    return (
                      <tr key={p.pid} className={rowClass}>
                        <td className="col-pid">{p.pid}</td>
                        <td className="col-name">
                          {p.name}
                          {p.protected && <span className="badge-protected">protegido</span>}
                        </td>
                        <td className="col-num">{p.memory_mb}</td>
                        <td className="col-num">{p.cpu_usage.toFixed(1)}</td>
                        <td className="col-action">
                          <button
                            className="btn-kill"
                            disabled={p.protected || killingPid === p.pid}
                            onClick={() => handleKill(p)}
                          >
                            {killingPid === p.pid ? "..." : "Cerrar"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          </>
        )}

        {view === "startup" && (
          <>
            <h2 className="view-title">Inicio de Windows</h2>
            <section className="panel panel--table">
              <div className="panel-head">
                <h2>Programas de inicio</h2>
                <span className="panel-subtext">{startupPrograms.length} registrados</span>
              </div>
              <table className="process-table">
                <thead>
                  <tr>
                    <th className="col-name">Programa</th>
                    <th className="col-name">Ubicación</th>
                    <th className="col-action">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {startupPrograms.map((p) => (
                    <tr key={p.name}>
                      <td className="col-name">{p.name}</td>
                      <td className="col-name">
                        <span className="badge-location">{p.location}</span>
                      </td>
                      <td className="col-action">
                        <button
                          className={p.enabled ? "btn-toggle btn-toggle--on" : "btn-toggle btn-toggle--off"}
                          disabled={togglingName === p.name}
                          onClick={() => handleToggleStartup(p)}
                        >
                          {togglingName === p.name ? "..." : p.enabled ? "Activado" : "Desactivado"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}

        {view === "temp" && (
          <>
            <h2 className="view-title">Archivos temporales</h2>
            <section className="panel panel--table">
              <div className="panel-head">
                <h2>Categorías</h2>
                <button className="btn-scan" onClick={handleScanTemp} disabled={scanningTemp}>
                  {scanningTemp ? "Escaneando..." : "Escanear"}
                </button>
              </div>

              {tempCategories.length === 0 ? (
                <p className="panel-subtext">Presiona "Escanear" para ver cuánto espacio se puede liberar.</p>
              ) : (
                <table className="process-table">
                  <thead>
                    <tr>
                      <th className="col-name">Categoría</th>
                      <th className="col-num">Archivos</th>
                      <th className="col-num">Tamaño</th>
                      <th className="col-action"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tempCategories.map((cat) => (
                      <tr key={cat.id}>
                        <td className="col-name">{cat.label}</td>
                        <td className="col-num">{cat.file_count}</td>
                        <td className="col-num">{cat.size_mb} MB</td>
                        <td className="col-action">
                          <button
                            className="btn-kill"
                            disabled={cleaningId === cat.id || cat.file_count === 0}
                            onClick={() => handleCleanTemp(cat)}
                          >
                            {cleaningId === cat.id ? "..." : "Limpiar"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;