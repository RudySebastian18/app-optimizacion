use std::sync::Mutex;
use sysinfo::System;
use tauri::Emitter;

use std::collections::{HashMap, VecDeque};

const MAX_HISTORY_SAMPLES: usize = 30;
const MIN_SAMPLES_FOR_BASELINE: usize = 5;

#[derive(Default)]
struct ProcessHistory {
    cpu_samples: VecDeque<f32>,
    mem_samples: VecDeque<u64>,
}

struct AppState {
    sys: Mutex<System>,
    history: Mutex<HashMap<String, ProcessHistory>>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(serde::Serialize)]
struct SystemInfo {
    total_ram_mb: u64,
    used_ram_mb: u64,
    cpu_usage: f32,
}

#[tauri::command]
fn get_system_info(state: tauri::State<AppState>) -> SystemInfo {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_all();

    SystemInfo {
        total_ram_mb: sys.total_memory() / 1024 / 1024,
        used_ram_mb: sys.used_memory() / 1024 / 1024,
        cpu_usage: sys.global_cpu_usage(),
    }
}

#[derive(serde::Serialize)]
struct ProcessInfo {
    pid: u32,
    name: String,
    memory_mb: u64,
    cpu_usage: f32,
    protected: bool,
}

const PROTECTED_PROCESSES: &[&str] = &[
    "system",
    "system idle process",
    "registry",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "smss.exe",
    "svchost.exe",
    "explorer.exe",
    "dwm.exe",
    "fontdrvhost.exe",
    "memory compression",
    "runtimebroker.exe",
];

fn is_protected(name: &str) -> bool {
    let lower = name.to_lowercase();
    PROTECTED_PROCESSES.contains(&lower.as_str())
}

#[tauri::command]
fn get_processes(state: tauri::State<AppState>) -> Vec<ProcessInfo> {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_all();

    let mut processes: Vec<ProcessInfo> = sys
        .processes()
        .iter()
        .map(|(pid, process)| {
            let name = process.name().to_string_lossy().to_string();
            ProcessInfo {
                pid: pid.as_u32(),
                protected: is_protected(&name),
                name,
                memory_mb: process.memory() / 1024 / 1024,
                cpu_usage: process.cpu_usage(),
            }
        })
        .collect();

    processes.sort_by(|a, b| b.memory_mb.cmp(&a.memory_mb));
    processes.truncate(20);

    processes
}

#[tauri::command]
fn kill_process(state: tauri::State<AppState>, pid: u32) -> Result<(), String> {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_all();

    if pid == std::process::id() {
        return Err("No puedes cerrar la propia app de optimización.".into());
    }

    let sys_pid = sysinfo::Pid::from_u32(pid);

    let Some(process) = sys.process(sys_pid) else {
        return Err("El proceso ya no existe (puede que se haya cerrado solo).".into());
    };

    let name = process.name().to_string_lossy().to_string();
    if is_protected(&name) {
        return Err(format!("\"{}\" es un proceso protegido del sistema y no puede cerrarse.", name));
    }

    if process.kill() {
        Ok(())
    } else {
        Err("No se pudo cerrar el proceso (puede requerir permisos de administrador).".into())
    }
}

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, GetTokenInformation, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES,
    SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_ELEVATION, TOKEN_PRIVILEGES,
    TOKEN_QUERY, TokenElevation,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_NORMAL;
use windows::core::{PCSTR, PCWSTR};

const SYSTEM_MEMORY_LIST_INFORMATION: u32 = 80;
const MEMORY_EMPTY_WORKING_SETS: u32 = 2;
const MEMORY_FLUSH_MODIFIED_LIST: u32 = 3;
const MEMORY_PURGE_STANDBY_LIST: u32 = 4;

type NtSetSystemInformationFn =
    unsafe extern "system" fn(u32, *mut core::ffi::c_void, u32) -> i32;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION::default();
        let mut ret_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        );

        let _ = CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
}

fn relaunch_as_admin() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_wide = wide(&exe.to_string_lossy());
    let verb = wide("runas");

    unsafe {
        let result = ShellExecuteW(
            HWND::default(),
            PCWSTR(verb.as_ptr()),
            PCWSTR(exe_wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_NORMAL,
        );

        if (result.0 as isize) <= 32 {
            return Err("Se canceló la solicitud de permisos de administrador.".into());
        }
    }
    Ok(())
}

fn resolve_nt_set_system_information() -> Result<NtSetSystemInformationFn, String> {
    unsafe {
        let module_name = wide("ntdll.dll");
        let module = GetModuleHandleW(PCWSTR(module_name.as_ptr()))
            .map_err(|e| format!("No se pudo obtener ntdll.dll: {e}"))?;

        match GetProcAddress(module, PCSTR(b"NtSetSystemInformation\0".as_ptr())) {
            Some(addr) => Ok(std::mem::transmute::<_, NtSetSystemInformationFn>(addr)),
            None => Err("No se encontró NtSetSystemInformation en ntdll.dll".into()),
        }
    }
}

fn enable_privilege(name: &str) -> Result<(), String> {
    unsafe {
        let mut token_handle = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token_handle,
        )
        .map_err(|e| format!("No se pudo abrir el token del proceso: {e}"))?;

        let wide_name = wide(name);
        let mut luid = LUID::default();
        LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(wide_name.as_ptr()), &mut luid)
            .map_err(|e| format!("No se encontró el privilegio {name}: {e}"))?;

        let mut tp = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };

        let result = AdjustTokenPrivileges(token_handle, false, Some(&mut tp), 0, None, None);
        let _ = CloseHandle(token_handle);

        result.map_err(|e| format!("No se pudo activar el privilegio {name}: {e}"))
    }
}

fn purge_memory_command(func: NtSetSystemInformationFn, mut command: u32) -> Result<(), String> {
    unsafe {
        let status = func(
            SYSTEM_MEMORY_LIST_INFORMATION,
            &mut command as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );

        if status != 0 {
            return Err(format!("El sistema rechazó la operación (código {status})."));
        }
    }
    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct FreeRamProgress {
    stage: String,
    label: String,
}

#[derive(serde::Serialize)]
struct FreeRamResult {
    message: String,
    freed_mb: i64,
    after_mb: u64,
}

#[tauri::command]
fn free_ram(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<FreeRamResult, String> {
    if !is_elevated() {
        relaunch_as_admin()?;
        std::process::exit(0);
    }

    enable_privilege("SeProfileSingleProcessPrivilege")?;
    enable_privilege("SeIncreaseQuotaPrivilege")?;

    let nt_set_system_information = resolve_nt_set_system_information()?;

    let before_mb = {
        let mut sys = state.sys.lock().unwrap();
        sys.refresh_memory();
        sys.used_memory() / 1024 / 1024
    };

    let _ = app.emit("free-ram-progress", FreeRamProgress {
        stage: "working_sets".into(),
        label: "Vaciando espacios de trabajo de procesos...".into(),
    });
    purge_memory_command(nt_set_system_information, MEMORY_EMPTY_WORKING_SETS)?;
    std::thread::sleep(std::time::Duration::from_millis(450));

    let _ = app.emit("free-ram-progress", FreeRamProgress {
        stage: "modified_list".into(),
        label: "Escribiendo páginas modificadas a disco...".into(),
    });
    purge_memory_command(nt_set_system_information, MEMORY_FLUSH_MODIFIED_LIST)?;
    std::thread::sleep(std::time::Duration::from_millis(450));

    let _ = app.emit("free-ram-progress", FreeRamProgress {
        stage: "standby_list".into(),
        label: "Purgando caché en espera (standby)...".into(),
    });
    purge_memory_command(nt_set_system_information, MEMORY_PURGE_STANDBY_LIST)?;
    std::thread::sleep(std::time::Duration::from_millis(450));

    let after_mb = {
        let mut sys = state.sys.lock().unwrap();
        sys.refresh_memory();
        sys.used_memory() / 1024 / 1024
    };

    let freed_mb = before_mb as i64 - after_mb as i64;

    let _ = app.emit("free-ram-progress", FreeRamProgress {
        stage: "done".into(),
        label: format!("Completado — {} MB liberados", freed_mb.max(0)),
    });

    Ok(FreeRamResult {
        message: "Memoria liberada correctamente.".into(),
        freed_mb,
        after_mb,
    })
}

use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_SET_VALUE};
use winreg::RegKey;

const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const DISABLED_KEY_PATH: &str = r"Software\AppOptimizacion\DisabledStartup";

#[derive(Clone, serde::Serialize)]
struct StartupProgram {
    name: String,
    command: String,
    location: String,
    enabled: bool,
}

fn read_run_entries(hive: winreg::HKEY, location: &str) -> Vec<StartupProgram> {
    let root = RegKey::predef(hive);
    let mut out = Vec::new();

    if let Ok(key) = root.open_subkey(RUN_KEY_PATH) {
        for (name, _) in key.enum_values().filter_map(|r| r.ok()) {
            if let Ok(command) = key.get_value::<String, _>(&name) {
                out.push(StartupProgram {
                    name,
                    command,
                    location: location.into(),
                    enabled: true,
                });
            }
        }
    }
    out
}

fn read_disabled_entries() -> Vec<StartupProgram> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mut out = Vec::new();

    if let Ok(key) = hkcu.open_subkey(DISABLED_KEY_PATH) {
        for name in key.enum_keys().filter_map(|r| r.ok()) {
            if let Ok(sub) = key.open_subkey(&name) {
                let command: String = sub.get_value("command").unwrap_or_default();
                let location: String = sub.get_value("location").unwrap_or_else(|_| "HKCU".into());
                out.push(StartupProgram { name, command, location, enabled: false });
            }
        }
    }
    out
}

#[tauri::command]
fn get_startup_programs() -> Vec<StartupProgram> {
    let mut all = read_run_entries(HKEY_CURRENT_USER, "HKCU");
    all.extend(read_run_entries(HKEY_LOCAL_MACHINE, "HKLM"));
    all.extend(read_disabled_entries());
    all.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    all
}

#[tauri::command]
fn toggle_startup_program(name: String, command: String, location: String, enable: bool) -> Result<(), String> {
    if !is_elevated() {
        relaunch_as_admin()?;
        std::process::exit(0);
    }

    let hive = if location == "HKLM" { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER };
    let root = RegKey::predef(hive);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    if enable {
        let run_key = root
            .open_subkey_with_flags(RUN_KEY_PATH, KEY_SET_VALUE)
            .map_err(|e| format!("No se pudo abrir la llave de inicio: {e}"))?;
        run_key
            .set_value(&name, &command)
            .map_err(|e| format!("No se pudo reactivar \"{name}\": {e}"))?;

        if let Ok(disabled_root) = hkcu.open_subkey(DISABLED_KEY_PATH) {
            let _ = disabled_root.delete_subkey_all(&name);
        }
    } else {
        let (disabled_root, _) = hkcu
            .create_subkey(DISABLED_KEY_PATH)
            .map_err(|e| e.to_string())?;
        let (entry, _) = disabled_root
            .create_subkey(&name)
            .map_err(|e| e.to_string())?;
        entry.set_value("command", &command).map_err(|e| e.to_string())?;
        entry.set_value("location", &location).map_err(|e| e.to_string())?;

        if let Ok(run_key) = root.open_subkey_with_flags(RUN_KEY_PATH, KEY_SET_VALUE) {
            let _ = run_key.delete_value(&name);
        }
    }

    Ok(())
}

use std::fs;
use std::path::Path;

#[derive(Clone, serde::Serialize)]
struct TempCategory {
    id: String,
    label: String,
    path: String,
    size_mb: u64,
    file_count: u64,
}

fn dir_stats(path: &Path) -> (u64, u64) {
    let mut total_size: u64 = 0;
    let mut count: u64 = 0;

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                let (s, c) = dir_stats(&entry_path);
                total_size += s;
                count += c;
            } else if let Ok(meta) = entry.metadata() {
                total_size += meta.len();
                count += 1;
            }
        }
    }

    (total_size, count)
}

#[tauri::command]
fn get_temp_categories() -> Vec<TempCategory> {
    let mut categories = Vec::new();

    if let Ok(user_temp) = std::env::var("TEMP") {
        let (size, count) = dir_stats(Path::new(&user_temp));
        categories.push(TempCategory {
            id: "user_temp".into(),
            label: "Temporales del usuario".into(),
            path: user_temp,
            size_mb: size / 1024 / 1024,
            file_count: count,
        });
    }

    let windows_temp = r"C:\Windows\Temp".to_string();
    let (size, count) = dir_stats(Path::new(&windows_temp));
    categories.push(TempCategory {
        id: "windows_temp".into(),
        label: "Temporales de Windows".into(),
        path: windows_temp,
        size_mb: size / 1024 / 1024,
        file_count: count,
    });

    categories
}

#[derive(serde::Serialize)]
struct CleanResult {
    freed_mb: u64,
    deleted_count: u64,
    skipped_count: u64,
}

fn clean_dir_contents(path: &Path) -> CleanResult {
    let mut freed: u64 = 0;
    let mut deleted: u64 = 0;
    let mut skipped: u64 = 0;

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let entry_path = entry.path();

            if entry_path.is_dir() {
                let sub_result = clean_dir_contents(&entry_path);
                freed += sub_result.freed_mb;
                deleted += sub_result.deleted_count;
                skipped += sub_result.skipped_count;
                let _ = fs::remove_dir(&entry_path);
            } else if let Ok(meta) = entry.metadata() {
                let size = meta.len();
                match fs::remove_file(&entry_path) {
                    Ok(_) => {
                        freed += size;
                        deleted += 1;
                    }
                    Err(_) => {
                        skipped += 1;
                    }
                }
            }
        }
    }

    CleanResult {
        freed_mb: freed / 1024 / 1024,
        deleted_count: deleted,
        skipped_count: skipped,
    }
}

#[tauri::command]
fn clean_temp_category(path: String) -> Result<CleanResult, String> {
    if !is_elevated() {
        relaunch_as_admin()?;
        std::process::exit(0);
    }

    let target = Path::new(&path);
    if !target.exists() {
        return Err("La carpeta no existe.".into());
    }

    Ok(clean_dir_contents(target))
}

// ---- Analizador de espacio en disco ----

#[derive(Clone, serde::Serialize)]
struct FolderEntry {
    name: String,
    path: String,
    size_mb: u64,
    is_dir: bool,
}

const SKIP_ENTRIES: &[&str] = &[
    "system volume information",
    "$recycle.bin",
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
    "recovery",
];

fn should_skip(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if SKIP_ENTRIES.contains(&name.as_str()) {
        return true;
    }

    // Evita seguir junctions/symlinks: es la causa más común de recursión infinita en Windows.
    match fs::symlink_metadata(path) {
        Ok(meta) => meta.file_type().is_symlink(),
        Err(_) => true, // si no se puede leer, mejor omitir que arriesgarse
    }
}

use jwalk::WalkDir;

fn calc_dir_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .skip_hidden(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| !should_skip(&entry.path()))
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.metadata().map(|m| m.len()).unwrap_or(0))
        .sum()
}

#[tauri::command]
fn get_drives() -> Vec<String> {
    let mut drives = Vec::new();
    for letter in b'A'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        if Path::new(&drive).exists() {
            drives.push(drive);
        }
    }
    drives
}
use rayon::prelude::*;

#[tauri::command]
async fn get_folder_sizes(path: String) -> Result<Vec<FolderEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = Path::new(&path);
        if !base.exists() {
            return Err("La ruta no existe.".into());
        }

        let read = fs::read_dir(base).map_err(|e| format!("No se pudo leer la carpeta ({e})"))?;

        let raw_entries: Vec<(String, std::path::PathBuf, bool)> = read
            .filter_map(|e| e.ok())
            .map(|entry| {
                let p = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let is_dir = p.is_dir();
                (name, p, is_dir)
            })
            .filter(|(_, p, _)| !should_skip(p))
            .collect();

        // Cada carpeta se calcula en un hilo distinto, aprovechando todos los núcleos.
        let mut entries: Vec<FolderEntry> = raw_entries
            .par_iter()
            .map(|(name, p, is_dir)| {
                let size = if *is_dir {
                    calc_dir_size(p)
                } else {
                    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                };

                FolderEntry {
                    name: name.clone(),
                    path: p.to_string_lossy().to_string(),
                    size_mb: size / 1024 / 1024,
                    is_dir: *is_dir,
                }
            })
            .collect();

        entries.sort_by(|a, b| b.size_mb.cmp(&a.size_mb));
        Ok(entries)
    })
    .await
    .map_err(|e| format!("Error interno: {e}"))?
}

fn mean_and_stddev(samples: &VecDeque<f32>) -> (f64, f64) {
    let n = samples.len() as f64;
    if n == 0.0 {
        return (0.0, 0.0);
    }
    let mean: f64 = samples.iter().map(|&v| v as f64).sum::<f64>() / n;
    let variance: f64 = samples.iter().map(|&v| (v as f64 - mean).powi(2)).sum::<f64>() / n;
    (mean, variance.sqrt())
}

#[derive(Clone, serde::Serialize)]
struct AnomalyAlert {
    process_name: String,
    metric: String, // "ram" o "cpu"
    current_value: f64,
    baseline_avg: f64,
    severity: String, // "warning" o "critical"
    message: String,
}

#[tauri::command]
fn get_anomalies(state: tauri::State<AppState>) -> Vec<AnomalyAlert> {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_all();

    // Agrupa por nombre de proceso (puede haber varias instancias, ej. varios "chrome.exe")
    let mut aggregated: HashMap<String, (f32, u64)> = HashMap::new();
    for (_, process) in sys.processes() {
        let name = process.name().to_string_lossy().to_string();
        let entry = aggregated.entry(name).or_insert((0.0, 0));
        entry.0 += process.cpu_usage();
        entry.1 += process.memory() / 1024 / 1024;
    }

    let mut history = state.history.lock().unwrap();
    let mut alerts = Vec::new();

    for (name, (cpu, mem_mb)) in aggregated.iter() {
        let record = history.entry(name.clone()).or_default();

        // Compara contra el historial ANTES de agregar la muestra actual.
        if record.cpu_samples.len() >= MIN_SAMPLES_FOR_BASELINE {
            let (cpu_mean, cpu_std) = mean_and_stddev(&record.cpu_samples);
            let (mem_mean, _mem_std) = {
                let float_samples: VecDeque<f32> =
                    record.mem_samples.iter().map(|&v| v as f32).collect();
                mean_and_stddev(&float_samples)
            };

            // RAM: solo alerta si el salto es grande Y relevante en términos absolutos (evita ruido en procesos que usan pocos MB)
            if mem_mean > 20.0 && (*mem_mb as f64) > mem_mean * 1.6 {
                let severity = if (*mem_mb as f64) > mem_mean * 2.5 { "critical" } else { "warning" };
                alerts.push(AnomalyAlert {
                    process_name: name.clone(),
                    metric: "ram".into(),
                    current_value: *mem_mb as f64,
                    baseline_avg: mem_mean,
                    severity: severity.into(),
                    message: format!(
                        "\"{}\" está usando {} MB de RAM, muy por encima de su promedio habitual (~{:.0} MB).",
                        name, mem_mb, mem_mean
                    ),
                });
            }

            // CPU: umbral absoluto también (evita marcar saltos de 0.1% a 0.3% como "anomalía")
            if cpu_mean > 3.0 && (*cpu as f64) > cpu_mean as f64 + (cpu_std as f64 * 2.0).max(cpu_mean as f64 * 0.6) {
                let severity = if (*cpu as f64) > cpu_mean as f64 * 2.5 { "critical" } else { "warning" };
                alerts.push(AnomalyAlert {
                    process_name: name.clone(),
                    metric: "cpu".into(),
                    current_value: *cpu as f64,
                    baseline_avg: cpu_mean as f64,
                    severity: severity.into(),
                    message: format!(
                        "\"{}\" está usando {:.1}% de CPU, muy por encima de su promedio habitual (~{:.1}%).",
                        name, cpu, cpu_mean
                    ),
                });
            }
        }

        // Guarda la muestra actual para futuras comparaciones
        record.cpu_samples.push_back(*cpu);
        record.mem_samples.push_back(*mem_mb);
        if record.cpu_samples.len() > MAX_HISTORY_SAMPLES {
            record.cpu_samples.pop_front();
        }
        if record.mem_samples.len() > MAX_HISTORY_SAMPLES {
            record.mem_samples.pop_front();
        }
    }

    alerts.sort_by(|a, b| b.current_value.partial_cmp(&a.current_value).unwrap());
    alerts
}

#[derive(Clone, serde::Serialize)]
struct DiskHealth {
    name: String,
    total_gb: f64,
    free_gb: f64,
    used_pct: f64,
}

#[tauri::command]
fn get_disk_health() -> Vec<DiskHealth> {
    let disks = sysinfo::Disks::new_with_refreshed_list();

    disks
        .iter()
        .map(|d| {
            let total = d.total_space() as f64 / 1024.0 / 1024.0 / 1024.0;
            let free = d.available_space() as f64 / 1024.0 / 1024.0 / 1024.0;
            let used_pct = if total > 0.0 { (total - free) / total * 100.0 } else { 0.0 };

            DiskHealth {
                name: d.mount_point().to_string_lossy().to_string(),
                total_gb: total,
                free_gb: free,
                used_pct,
            }
        })
        .filter(|d| d.total_gb > 0.0)
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            sys: Mutex::new(System::new_all()),
            history: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_system_info,
            get_processes,
            kill_process,
            free_ram,
            get_startup_programs,
            toggle_startup_program,
            get_temp_categories,
            clean_temp_category,
            get_drives,
            get_folder_sizes,
            get_anomalies,
            get_disk_health
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}