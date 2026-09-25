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

interface FolderEntry {
  name: string;
  path: string;
  size_mb: number;
  is_dir: boolean;
}

interface AnomalyAlert {
  process_name: string;
  metric: string;
  current_value: number;
  baseline_avg: number;
  severity: string;
  message: string;
}

interface DiskHealth {
  name: string;
  total_gb: number;
  free_gb: number;
  used_pct: number;
}

type SortKey = "memory_mb" | "cpu_usage" | "name";
type View = "dashboard" | "processes" | "startup" | "temp" | "disk" | "anomalies" | "health";

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
  { id: "health", label: "Salud del sistema" },
  { id: "dashboard", label: "Panel general" },
  { id: "processes", label: "Procesos" },
  { id: "startup", label: "Inicio de Windows" },
  { id: "temp", label: "Archivos temporales" },
  { id: "disk", label: "Espacio en disco" },
  { id: "anomalies", label: "Anomalías" },
];

function formatSize(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  return mb + " MB";
}

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

  const [drives, setDrives] = useState<string[]>([]);
  const [diskHistory, setDiskHistory] = useState<string[]>([]);
  const [diskEntries, setDiskEntries] = useState<FolderEntry[]>([]);
  const [loadingDisk, setLoadingDisk] = useState(false);

  const [anomalies, setAnomalies] = useState<AnomalyAlert[]>([]);
  const [diskHealth, setDiskHealth] = useState<DiskHealth[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      const info = await invoke<SystemInfo>("get_system_info");
      setSysInfo(info);
      const procs = await invoke<ProcessInfo[]>("get_processes");
      setProcesses(procs);
      const anom = await invoke<AnomalyAlert[]>("get_anomalies");
      setAnomalies(anom);
      const disks = await invoke<DiskHealth[]>("get_disk_health");
      setDiskHealth(disks);
    };

    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    invoke<StartupProgram[]>("get_startup_programs").then(setStartupPrograms);
  }, []);

  useEffect(() => {
    invoke<string[]>("get_drives").then(setDrives);
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

  const healthScore = useMemo(() => {
    const ramPct = sysInfo ? (sysInfo.used_ram_mb / sysInfo.total_ram_mb) * 100 : 0;
    const cpuPct = sysInfo?.cpu_usage ?? 0;
    const worstDiskPct = diskHealth.length > 0 ? Math.max(...diskHealth.map((d) => d.used_pct)) : 0;
    const enabledStartupCount = startupPrograms.filter((p) => p.enabled).length;

    const ramScore = Math.max(0, 100 - ramPct);
    const cpuScore = Math.max(0, 100 - cpuPct);
    const diskScore = Math.max(0, 100 - worstDiskPct);
    const anomalyScore = Math.max(0, 100 - anomalies.length * 15);
    const startupScore = Math.max(0, 100 - Math.max(0, enabledStartupCount - 8) * 10);

    const overall =
      ramScore * 0.25 + cpuScore * 0.2 + diskScore * 0.2 + anomalyScore * 0.2 + startupScore * 0.15;

    let grade = "Crítico";
    let gradeLevel = "critical";
    if (overall >= 85) { grade = "Excelente"; gradeLevel = "normal"; }
    else if (overall >= 65) { grade = "Bueno"; gradeLevel = "normal"; }
    else if (overall >= 45) { grade = "Regular"; gradeLevel = "warning"; }

    return {
      overall: Math.round(overall),
      grade,
      gradeLevel,
      breakdown: [
        { label: "Memoria RAM", score: Math.round(ramScore), detail: `${ramPct.toFixed(0)}% en uso` },
        { label: "Procesador", score: Math.round(cpuScore), detail: `${cpuPct.toFixed(0)}% en uso` },
        { label: "Espacio en disco", score: Math.round(diskScore), detail: diskHealth.length > 0 ? `${worstDiskPct.toFixed(0)}% ocupado (peor unidad)` : "sin datos" },
        { label: "Anomalías activas", score: Math.round(anomalyScore), detail: `${anomalies.length} detectadas` },
        { label: "Programas de inicio", score: Math.round(startupScore), detail: `${enabledStartupCount} activos` },
      ],
    };
  }, [sysInfo, diskHealth, anomalies, startupPrograms]);

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

  async function loadDiskPath(path: string, pushHistory = true) {
    if (diskCache[path]) {
      setDiskEntries(diskCache[path]);
      if (pushHistory) setDiskHistory((prev) => [...prev, path]);
      return;
    }

    setLoadingDisk(true);
    try {
      const entries = await invoke<FolderEntry[]>("get_folder_sizes", { path });
      setDiskCache((prev) => ({ ...prev, [path]: entries }));
      setDiskEntries(entries);
      if (pushHistory) {
        setDiskHistory((prev) => [...prev, path]);
      }
    } catch (err) {
      setFeedback({ type: "error", text: String(err) });
    } finally {
      setLoadingDisk(false);
    }
  }

  function handleSelectDrive(drive: string) {
    setDiskHistory([]);
    loadDiskPath(drive);
  }

  function handleEnterFolder(entry: FolderEntry) {
    if (!entry.is_dir) return;
    loadDiskPath(entry.path);
  }

  function handleDiskBack() {
    if (diskHistory.length === 0) return;

    if (diskHistory.length === 1) {
      // Vuelve a la selección de unidad
      setDiskHistory([]);
      setDiskEntries([]);
      return;
    }

  const newHistory = diskHistory.slice(0, -1);
  const parent = newHistory[newHistory.length - 1];
  setDiskHistory(newHistory);
  loadDiskPath(parent, false);
}

  const currentDiskPath = diskHistory[diskHistory.length - 1] ?? "";
  const maxDiskEntrySize = Math.max(1, ...diskEntries.map((e) => e.size_mb));

  const ramUsedGb = sysInfo ? (sysInfo.used_ram_mb / 1024).toFixed(1) : "—";
  const ramTotalGb = sysInfo ? (sysInfo.total_ram_mb / 1024).toFixed(1) : "—";
  const [diskCache, setDiskCache] = useState<Record<string, FolderEntry[]>>({});
  
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
              {item.id === "anomalies" && anomalies.length > 0 && (
                <span className="nav-badge">{anomalies.length}</span>
              )}
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

        {view === "disk" && (
          <>
            <h2 className="view-title">Espacio en disco</h2>
            <section className="panel panel--table">
              {diskHistory.length === 0 ? (
                <>
                  <div className="panel-head">
                    <h2>Selecciona una unidad</h2>
                  </div>
                  <div className="drive-list">
                    {drives.map((d) => (
                      <button
                        key={d}
                        className="drive-button"
                        onClick={() => handleSelectDrive(d)}
                        disabled={loadingDisk}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  {loadingDisk && (
                    <p className="panel-subtext scanning-hint">
                      Escaneando unidad completa — en discos grandes (C:\) puede tardar varios minutos, la app sigue respondiendo mientras tanto.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="panel-head">
                    <div className="breadcrumb">
                      <button
                        className="btn-scan"
                        onClick={handleDiskBack}
                        disabled={loadingDisk}
                      >
                        ← Atrás
                      </button>
                      <span className="breadcrumb-path">{currentDiskPath}</span>
                    </div>
                    <span className="panel-subtext">
                      {loadingDisk ? "Calculando tamaños..." : `${diskEntries.length} elementos`}
                    </span>
                  </div>

                  {loadingDisk ? (
                    <div className="scanning-block">
                      <span className="spinner" />
                      <span>Calculando tamaños de carpetas, un momento...</span>
                    </div>
                  ) : (
                    <table className="process-table">
                      <thead>
                        <tr>
                          <th className="col-name">Nombre</th>
                          <th className="col-num">Tamaño</th>
                          <th className="col-bar"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {diskEntries.map((entry) => (
                          <tr
                            key={entry.path}
                            className={entry.is_dir ? "row-clickable" : ""}
                            onClick={() => handleEnterFolder(entry)}
                          >
                            <td className="col-name">
                              {entry.is_dir ? "📁 " : "📄 "}
                              {entry.name}
                            </td>
                            <td className="col-num">{formatSize(entry.size_mb)}</td>
                            <td className="col-bar">
                              <div className="size-bar-track">
                                <div
                                  className="size-bar-fill"
                                  style={{ width: `${(entry.size_mb / maxDiskEntrySize) * 100}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </section>
          </>
        )}

        {view === "anomalies" && (
          <>
            <h2 className="view-title">Anomalías detectadas</h2>
            <section className="panel panel--table">
              <div className="panel-head">
                <h2>Comportamiento fuera de lo normal</h2>
                <span className="panel-subtext">
                  Comparado contra el historial de cada proceso (últimos ~60s)
                </span>
              </div>

              {anomalies.length === 0 ? (
                <p className="panel-subtext">
                  Sin anomalías por ahora. La app necesita ~10 segundos de historial por proceso antes de poder detectar patrones inusuales.
                </p>
              ) : (
                <div className="anomaly-list">
                  {anomalies.map((a, i) => (
                    <div key={i} className={`anomaly-card anomaly-card--${a.severity}`}>
                      <div className="anomaly-head">
                        <span className="anomaly-name">{a.process_name}</span>
                        <span className={`anomaly-severity anomaly-severity--${a.severity}`}>
                          {a.severity === "critical" ? "crítico" : "atención"}
                        </span>
                      </div>
                      <p className="anomaly-message">{a.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {view === "health" && (
          <>
            <h2 className="view-title">Salud del sistema</h2>
            <section className="panel panel--score">
              <div className="score-main">
                <div className={`score-circle score-circle--${healthScore.gradeLevel}`}>
                  <span className="score-number">{healthScore.overall}</span>
                  <span className="score-max">/100</span>
                </div>
                <div>
                  <span className={`score-grade score-grade--${healthScore.gradeLevel}`}>{healthScore.grade}</span>
                  <p className="panel-subtext">Basado en 5 factores, actualizado en vivo</p>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Desglose</h2>
              </div>
              <div className="breakdown-list">
                {healthScore.breakdown.map((item) => {
                  const level = item.score < 45 ? "critical" : item.score < 65 ? "warning" : "normal";
                  return (
                    <div key={item.label} className="breakdown-row">
                      <div className="breakdown-labels">
                        <span>{item.label}</span>
                        <span className="panel-subtext">{item.detail}</span>
                      </div>
                      <div className="gauge-track breakdown-track">
                        <div className={`gauge-fill gauge-fill--${level}`} style={{ width: `${item.score}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;