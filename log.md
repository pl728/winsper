# Winsper Development Log

## Step 1: Environment Setup ✅
**Date:** Dec 5, 2025

### What was done:
1. Installed `pnpm` globally via `npm install -g pnpm`
2. Created Tauri + React + TypeScript project using:
   ```bash
   pnpm create tauri-app@latest winsper --template react-ts --manager pnpm --yes
   ```
3. Moved project files from nested `winsper/winsper/` to root `winsper/`
4. Installed dependencies with `pnpm install`
5. Approved esbuild build scripts with `pnpm approve-builds`

### Files created:
- Standard Tauri v2 + React + TypeScript project structure
- `src/` - React frontend
- `src-tauri/` - Rust backend

### QA verification:
- ✅ Window opens with Tauri + React template
- ✅ Counter button works
- ✅ Hot reload functional

---

## Step 2: System Tray Behavior ✅
**Date:** Dec 5, 2025

### What was done:

1. **Updated `src-tauri/Cargo.toml`:**
   - Added `tray-icon` feature to tauri dependency:
     ```toml
     tauri = { version = "2", features = ["tray-icon"] }
     ```

2. **Updated `src-tauri/tauri.conf.json`:**
   - Added window label: `"label": "main"`
   - Changed window title to `"Winsper"`
   - Set window to start hidden: `"visible": false`
   - ~~Added trayIcon config~~ (removed - was creating duplicate)

3. **Updated `src-tauri/src/lib.rs`:**
   - Added imports for tray and menu modules
   - Created tray icon with right-click context menu:
     - "Show/Hide" - toggles window visibility
     - "Quit" - exits the application
   - Added left-click handler to show window
   - Added `on_window_event` handler to hide window on close instead of quitting

### Key code changes in `lib.rs`:
```rust
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

// In setup():
// - Build menu with "Show/Hide" and "Quit" items
// - Create TrayIconBuilder with menu and event handlers
// - Left-click shows window, right-click shows menu

// In on_window_event():
// - Intercept CloseRequested to hide instead of close
```

### Bug fix:
- Initially had duplicate tray icons (one from config, one from code)
- Removed `trayIcon` from `tauri.conf.json` to fix

### QA verification:
- ✅ App starts with window hidden
- ✅ Single tray icon appears in system tray
- ✅ Left-click tray icon shows window
- ✅ Right-click shows context menu with "Show/Hide" and "Quit"
- ✅ Clicking X button hides window (doesn't quit)
- ✅ "Quit" menu item exits app completely

---

## Step 3: Global Hotkey Detection ✅
**Date:** Dec 5, 2025

### What was done:

1. **Updated `src-tauri/Cargo.toml`:**
   - Added `rdev = "0.5"` dependency for low-level keyboard hooks

2. **Updated `src-tauri/src/lib.rs`:**
   - Added imports for `std::sync::{atomic::{AtomicBool, Ordering}, Arc}` and `rdev::{listen, Event, EventType, Key}`
   - Added `Emitter` trait import from tauri for event emission
   - Created `RecordingState` struct with `AtomicBool` to track recording status
   - Implemented `start_hotkey_listener()` function that:
     - Spawns a background thread with `rdev::listen`
     - Detects `Key::ControlRight` presses to toggle recording
     - Emits `"recording_started"` and `"recording_stopped"` events to frontend
     - Emits `"hotkey_event"` for testing UI (shows which key was pressed)
     - Logs to console: `[Hotkey] Recording started/stopped`
   - Wired up the listener in the `setup()` closure

### Key code additions:
```rust
pub struct RecordingState {
    pub is_recording: AtomicBool,
}

fn start_hotkey_listener(app: AppHandle, recording_state: Arc<RecordingState>) {
    std::thread::spawn(move || {
        let callback = move |event: Event| {
            if let EventType::KeyPress(key) = event.event_type {
                match key {
                    Key::ControlRight => {
                        // Toggle recording state and emit events
                    }
                    Key::Alt => {
                        // Emit hotkey event for testing
                    }
                    _ => {}
                }
            }
        };
        listen(callback);
    });
}
```

### QA verification:
- ✅ App compiles and runs with rdev dependency
- ✅ Pressing Right Ctrl first time emits `recording_started` event
- ✅ Pressing Right Ctrl second time emits `recording_stopped` event
- ✅ Console shows `[Hotkey] Recording started/stopped` messages
- ✅ `hotkey_event` emitted for testing UI

### Note:
- `rdev` on Windows doesn't have a separate `Key::AltRight` variant; using `Key::Alt` for future right-alt support
- The frontend will need to listen for these events to show recording state (next steps)

---

## Step 4: Audio Recording + Waveform Events ✅
**Date:** Dec 5, 2025

### What was done:

1. **Updated `src-tauri/Cargo.toml`:**
   - Added `cpal = "0.15"` dependency for cross-platform audio capture

2. **Updated `src-tauri/src/lib.rs`:**
   - Added imports for `cpal::traits::{DeviceTrait, HostTrait, StreamTrait}` and `cpal::Sample`
   - Created `AudioContext` struct to hold:
     - `buffer: Vec<f32>` - captured audio samples (mono, f32)
     - `sample_rate: u32` - detected sample rate
     - `stop_signal: Arc<AtomicBool>` - signal to stop recording thread
   - Created `SharedAudio` type alias for `Arc<Mutex<AudioContext>>`
   - Implemented `compute_rms()` function for waveform visualization (uses sliding window)
   - Implemented `start_audio_recording()` function that:
     - Gets default input device via cpal
     - Builds input stream for F32, I16, or U16 sample formats
     - Converts multi-channel audio to mono
     - Stores samples in shared buffer
     - Emits `audio_level` events (normalized 0-1) every ~2048 samples for waveform UI
     - Keeps stream alive in recording thread until stop_signal is set
   - Implemented `stop_audio_recording()` function that:
     - Sets stop_signal to terminate recording thread
     - Emits `recording_complete` event with samples, sample_rate, duration_seconds
   - Updated `start_hotkey_listener()` to call audio functions on hotkey toggle
   - Updated `setup()` to initialize AudioContext

### Key design decision:
- `cpal::Stream` is not `Send`/`Sync`, so it cannot be shared across threads
- Solution: Keep stream local to recording thread, use `AtomicBool` stop signal to control when to stop
- Stream is dropped automatically when recording thread exits its loop

### Events emitted:
- `audio_level` (f32: 0-1) - real-time audio level for waveform visualization
- `audio_error` (String) - if audio device unavailable or stream fails
- `recording_complete` (JSON: {samples, sample_rate, duration_seconds}) - on stop

### QA verification:
- ✅ App compiles with cpal dependency
- ✅ Pressing Right Ctrl starts audio recording (console shows device info)
- ✅ `audio_level` events emitted during recording
- ✅ Pressing Right Ctrl again stops recording
- ✅ `recording_complete` event emitted with captured audio stats
- ✅ Console shows sample count and duration

---

## Step 5: Whisper Integration ✅
**Date:** Dec 5, 2025

### What was done:

1. **Updated `src-tauri/Cargo.toml`:**
   - Added `whisper-rs = "0.13"` for Whisper.cpp Rust bindings
   - Added `rubato = "0.15"` for high-quality audio resampling

2. **Build dependencies installed:**
   - LLVM (for bindgen to generate FFI bindings)
   - CMake (for compiling whisper.cpp C++ code)

3. **Updated `src-tauri/src/lib.rs`:**
   - Added `WhisperState` struct to hold loaded model context
   - Added `SharedWhisper` type alias for thread-safe access
   - Implemented `resample_to_16khz()` - converts captured audio to 16kHz (Whisper requirement)
   - Implemented `run_whisper_on_buffer()` - runs transcription on audio buffer
   - Added `set_active_model` Tauri command - loads a Whisper model file
   - Added `get_active_model` Tauri command - returns current model path
   - Wired transcription into `stop_audio_recording()` flow

### Key code additions:
```rust
// WhisperState holds the loaded model
pub struct WhisperState {
    pub ctx: Option<WhisperContext>,
    pub model_path: Option<PathBuf>,
}

// Tauri commands for model management
#[tauri::command]
fn set_active_model(path: String, state: tauri::State<SharedWhisper>) -> Result<String, String>

#[tauri::command]
fn get_active_model(state: tauri::State<SharedWhisper>) -> Option<String>

// Audio resampling (48kHz → 16kHz) using rubato
fn resample_to_16khz(samples: &[f32], source_rate: u32) -> Result<Vec<f32>, String>

// Transcription function
fn run_whisper_on_buffer(samples: &[f32], sample_rate: u32, whisper_state: &SharedWhisper) -> Result<String, String>
```

### Events emitted:
- `transcription_started` - when Whisper begins processing
- `transcription_done` (String) - transcribed text on success
- `transcription_error` (String) - error message on failure

### QA verification:
- ✅ Build succeeds with whisper-rs compiled
- ✅ Audio resampling works (48000Hz → 16kHz)
- ✅ Graceful error when no model loaded: "No Whisper model loaded. Please set a model first."
- ✅ `set_active_model` command registered and accessible

### Note:
- User must download a Whisper model file (e.g., `ggml-base.en.bin`) from https://huggingface.co/ggerganov/whisper.cpp/tree/main
- Model is loaded via `set_active_model` command (UI will be added in Step 7)

---

## Step 6: Clipboard + Paste Simulation ✅
**Date:** Dec 5, 2025

### What was done:

1. **Updated `src-tauri/Cargo.toml`:**
   - Added `arboard = "3"` for clipboard operations

2. **Updated `src-tauri/src/lib.rs`:**
   - Added `arboard::Clipboard` import
   - Added `rdev::simulate` import for key simulation
   - Implemented `copy_to_clipboard()` - copies text to system clipboard
   - Implemented `simulate_paste()` - simulates Ctrl+V keystroke
   - Implemented `copy_to_clipboard_and_paste()` - combines both operations
   - Wired clipboard+paste into `stop_audio_recording()` after successful transcription

### Key code additions:
```rust
use arboard::Clipboard;
use rdev::{listen, simulate, Event, EventType, Key};

/// Copies text to the system clipboard
fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new()?;
    clipboard.set_text(text.to_string())?;
    Ok(())
}

/// Simulates Ctrl+V keystroke to paste from clipboard
fn simulate_paste() -> Result<(), String> {
    simulate(&EventType::KeyPress(Key::ControlLeft))?;
    simulate(&EventType::KeyPress(Key::KeyV))?;
    simulate(&EventType::KeyRelease(Key::KeyV))?;
    simulate(&EventType::KeyRelease(Key::ControlLeft))?;
    Ok(())
}
```

### Events emitted:
- `paste_error` (String) - if clipboard/paste operation fails (transcription still emitted)

### Flow:
1. User presses Right Ctrl to stop recording
2. Whisper transcribes the audio
3. Text is copied to clipboard
4. Ctrl+V is simulated to paste at cursor position
5. `transcription_done` event emitted to frontend

### QA verification:
- ✅ Text copied to clipboard after transcription
- ✅ Ctrl+V simulated to paste at cursor position

---

## Step 7: Frontend UI - Overlay ✅
**Date:** Dec 5, 2025

### What was done:

1. **Added overlay window in `src-tauri/tauri.conf.json`:**
   ```json
   {
     "label": "overlay",
     "title": "Winsper Overlay",
     "width": 300,
     "height": 80,
     "decorations": false,
     "transparent": true,
     "alwaysOnTop": true,
     "resizable": false,
     "visible": false,
     "skipTaskbar": true,
     "center": true,
     "shadow": false
   }
   ```

2. **Updated `src-tauri/src/lib.rs`:**
   - Added `PhysicalPosition` import for window positioning
   - Implemented `show_overlay()` - shows overlay at bottom-center of screen
   - Implemented `hide_overlay()` - hides overlay window
   - Called `show_overlay()` when recording starts (hotkey pressed)
   - Called `hide_overlay()` after transcription completes (success, error, or empty)

3. **Created `src/Overlay.tsx`:**
   - Listens for Tauri events: `recording_started`, `recording_stopped`, `transcription_started`, `transcription_done`, `transcription_error`
   - Three states: "recording", "transcribing", "error"
   - Recording state: Shows waveform SVG icon + "Speak..." text
   - Transcribing state: Shows spinner + "Transcribing..." text
   - Error state: Shows warning icon + error message

4. **Created `src/Overlay.css`:**
   - Single `.overlay-box` fills entire window (no nested elements)
   - Dark glassmorphism background: `rgba(24, 24, 27, 0.95)`
   - Backdrop blur effect
   - Rounded corners (16px)
   - Pulsing animation on waveform icon
   - Spinner animation for transcribing state
   - Fade-in animation on appear

5. **Updated `src/main.tsx`:**
   - Detects window label using `getCurrentWindow().label`
   - Renders `<Overlay />` for overlay window
   - Renders `<App />` for main window
   - Sets transparent background styles for overlay window

### Key design decisions:
- **Single box structure** - Removed nested container/content divs to avoid "two boxes" visual issue
- **No audio waveform visualization** - Simplified to just icon + text for cleaner UX
- **Inline SVG icon** - Avoided external dependency (react-icons) for simpler setup
- **Window transparency** - Required `transparent: true`, `shadow: false`, and CSS transparent backgrounds

### Files created/modified:
- `src/Overlay.tsx` - New overlay component
- `src/Overlay.css` - New overlay styles
- `src/main.tsx` - Window detection and routing
- `src-tauri/tauri.conf.json` - Overlay window config
- `src-tauri/src/lib.rs` - Show/hide overlay functions

### QA verification:
- ✅ Overlay appears at bottom-center when Right Ctrl pressed
- ✅ Shows "Speak..." with waveform icon during recording
- ✅ Shows "Transcribing..." with spinner after recording stops
- ✅ Shows error message if transcription fails
- ✅ Overlay disappears after transcription completes
- ✅ Hotkey works even when overlay is visible (no focus stealing)
- ✅ Single dark box with rounded corners (no nested box issue)

### Known issues fixed:
- Removed `set_focus()` on overlay to prevent keyboard event capture
- Added `shadow: false` to remove Windows window shadow outline
- Used single div structure to avoid double-box appearance

---

## Next Steps (Pending)

- **Step 7b:** Main window settings UI (model selector, hotkey test)
- **Step 8:** Production build and testing

