# AppOptimización

Aplicación de escritorio para Windows que monitorea y optimiza el rendimiento del sistema en tiempo real.

## Características

- Monitor en vivo de RAM y CPU
- Gestión de procesos (top 20 por consumo, con protección de procesos críticos del sistema)
- Liberación de memoria RAM (working sets, modified list, standby list — mismo mecanismo que usa Sysinternals RAMMap)
- Gestión de programas de inicio de Windows
- Limpieza de archivos temporales del usuario y del sistema

## Stack técnico

- **Backend**: Rust + Tauri
- **Frontend**: React + TypeScript
- **Crates clave**: sysinfo, winreg, windows-rs

## Desarrollo local

\\\powershell
npm install
npm run tauri dev
\\\

## Build de producción

\\\powershell
npm run tauri build
\\\

El instalador se genera en \src-tauri/target/release/bundle/msi/\.

## Descarga

Instalador disponible en la sección [Releases](../../releases) de este repositorio.
