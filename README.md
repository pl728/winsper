# Winsper

Voice-to-text system tray app for Windows with global hotkey activation and local Whisper transcription.

## Features

- **Global hotkey** - Press Right Ctrl to start/stop recording from anywhere
- **System tray resident** - Runs in background, minimal UI interference
- **Local transcription** - Uses Whisper.cpp for offline speech-to-text
- **Auto-paste** - Transcribed text automatically pastes at cursor position
- **Real-time overlay** - Visual feedback during recording and transcription

## Tech Stack

- **Frontend:** Tauri + React + TypeScript
- **Backend:** Rust (Tauri)
- **Audio:** cpal (cross-platform audio capture)
- **Transcription:** whisper-rs (Whisper.cpp bindings)
- **Hotkeys:** rdev (low-level keyboard hooks)

## Usage

1. Launch Winsper - it runs in the system tray
2. Open settings from tray menu
3. Download and select a Whisper model from within the app
4. Press **Right Ctrl** to start recording
5. Speak your text
6. Press **Right Ctrl** again to stop and transcribe
7. Text automatically pastes at your cursor

## Development

```bash
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm tauri build
```

## Requirements

- Windows with Visual Studio Build Tools
- LLVM and CMake (for whisper-rs compilation)
- Microphone input device
