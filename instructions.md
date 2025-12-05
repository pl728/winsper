Here’s a concrete plan you (or another AI) can follow to build this from scratch in an empty directory on **Windows**, with modern tooling and a local Whisper model.

I’ll assume:

* Frontend: **Tauri + React + TypeScript**
* Backend: **Rust** (Tauri) + **whisper-rs** (binding to `whisper.cpp`)
* Audio: **cpal** (cross-platform audio capture)
* Global key hook: **rdev** (to detect right Ctrl / right Alt)
* Clipboard & paste simulation: **arboard** (+ `rdev` for fake Ctrl+V)

---

## 0. High-level architecture

You’re building a Tauri app with:

1. **System tray resident app**

   * Main window hidden by default.
   * Tray icon in the bottom-right system tray.
   * When closed, it hides instead of exiting.
   * Tray menu: “Show/Hide”, “Quit”.

2. **Global hotkey listener (right Ctrl now, right Alt later)**

   * A **Rust background thread** using `rdev` that:

     * Detects **right Ctrl down → start recording**.
     * Detects **right Ctrl down again → stop recording & process**.
   * Sends events to the frontend via **Tauri events** (e.g., `"recording_started"`, `"recording_stopped"`, `"audio_level"`).

3. **Audio recorder + waveform**

   * Uses `cpal` to capture microphone audio into an in-memory buffer while recording.
   * Computes rough volume (RMS/peak) and sends to frontend for the waveform overlay.
   * After stop, writes the captured PCM into a temporary WAV buffer.

4. **Whisper integration**

   * Uses `whisper-rs` to:

     * Load a model file selected in the UI (e.g. `ggml-base.en.bin`).
     * Transcribe the recorded audio.
   * Returns the text to the frontend (and/or directly handles clipboard/paste in Rust).

5. **Clipboard + paste**

   * Copies transcription to the Windows clipboard.
   * Simulates `Ctrl+V` keystroke, so it pastes at the current focused window.

6. **Main window UI**

   * **Overlay**: small frameless window with a waveform while recording.
   * **Model Management**: choose active model (file path selector) and maybe a dropdown of saved models.
   * **Hotkey Test**: shows whether right Ctrl / right Alt events are detected.

---

## 1. Environment setup (for the AI)

In an empty directory:

1. **Install prerequisites (assumed installed; if not, another AI should do it):**

   * Rust toolchain (`rustup`).
   * Node.js (LTS).
   * `pnpm` or `npm` (pick one; I’ll use `pnpm`).
   * Visual Studio Build Tools / C++ build tools for Windows (for Rust + whisper.cpp compilation).

2. **Create Tauri + React project:**

From the empty directory:

```bash
pnpm create tauri-app
# or: npm create tauri-app@latest
```

* Choose:

  * Frontend: React + TypeScript.
  * Package manager: pnpm (or npm).
  * Name: `tray-whisper` (for example).

After creation:

```bash
cd tray-whisper
pnpm install
```

---

## 2. Configure Tauri for tray behavior

### 2.1 Enable system tray in `tauri.conf.json`

Open `src-tauri/tauri.conf.json` and:

* Ensure `"systemTray"` is present and enabled.
* Ensure `"windows"` initial window is **hidden on start**.

Example snippet (abridged):

```json
{
  "tauri": {
    "bundle": { "active": true },
    "systemTray": {
      "iconPath": "icons/icon.ico"
    },
    "windows": [
      {
        "label": "main",
        "title": "Tray Whisper",
        "fullscreen": false,
        "resizable": true,
        "visible": false,
        "decorations": true,
        "width": 800,
        "height": 600
      }
    ]
  }
}
```

### 2.2 Implement tray menu and “hide on close”

Edit `src-tauri/src/main.rs`:

1. Add dependencies in `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "shell", "clipboard"] }
rdev = "0.5"
cpal = "0.15"
whisper-rs = "0.10" # adjust to current version
arboard = "3"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
once_cell = "1.19"
```

2. In `main.rs`, set up:

* A system tray icon.
* Events on tray menu click.
* Intercept window close to **hide** instead of quit.

Skeleton:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    Manager, SystemTray, SystemTrayMenu, SystemTrayMenuItem, SystemTrayEvent,
    AppHandle,
};

fn build_tray() -> SystemTray {
    let menu = SystemTrayMenu::new()
        .add_item(SystemTrayMenuItem::new("show_hide", "Show/Hide"))
        .add_item(SystemTrayMenuItem::new("quit", "Quit"));

    SystemTray::new().with_menu(menu)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Hide on startup if desired
            let main_window = app.get_window("main").unwrap();
            main_window.hide().ok();
            Ok(())
        })
        .system_tray(build_tray())
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => {
                match id.as_str() {
                    "show_hide" => {
                        let window = app.get_window("main").unwrap();
                        if window.is_visible().unwrap_or(false) {
                            window.hide().ok();
                        } else {
                            window.show().ok();
                            window.set_focus().ok();
                        }
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                }
            }
            _ => {}
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                // Prevent closing; hide instead
                event.window().hide().ok();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

*(Later you’ll extend `main` with audio, hotkeys, whisper integration.)*

---

## 3. Global hotkey detection (right Ctrl)

### 3.1 Design

You want:

* Toggle behavior:

  * First **right Ctrl** press → start recording.
  * Second **right Ctrl** press → stop recording and process.
* Must distinguish right vs left Ctrl.

Tauri’s built-in global shortcuts can’t easily differentiate left vs right; but `rdev` can:

* It uses low-level hooks and gives you `Key::ControlRight`.

### 3.2 Implement the hotkey listener

In `main.rs`:

1. Add a global state to track recording status (e.g., `AtomicBool` or `Mutex`).
2. Spawn a background thread on app startup to hook keyboard events with `rdev::listen`.
3. When `Key::ControlRight` down event occurs:

   * If not recording: emit `"recording_started"` to the frontend and start audio capture.
   * Else: emit `"recording_stopped"` and stop audio capture, then run Whisper.

Pseudo-code structure (you’ll flesh out in real Rust code):

```rust
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;
use rdev::{listen, Event, EventType, Key};

struct RecordingState {
    is_recording: AtomicBool,
}

fn start_hotkey_listener(app: AppHandle, recording_state: Arc<RecordingState>) {
    std::thread::spawn(move || {
        let callback = move |event: Event| {
            if let EventType::KeyPress(key) = event.event_type {
                if key == Key::ControlRight {
                    let currently = recording_state.is_recording.load(Ordering::SeqCst);
                    if !currently {
                        // start recording
                        recording_state.is_recording.store(true, Ordering::SeqCst);
                        let _ = app.emit_all("recording_started", ());
                        // call some function to start audio
                        start_audio_recording(app.clone());
                    } else {
                        // stop recording
                        recording_state.is_recording.store(false, Ordering::SeqCst);
                        let _ = app.emit_all("recording_stopped", ());
                        stop_audio_and_transcribe(app.clone());
                    }
                }
            }
        };

        if let Err(err) = listen(callback) {
            eprintln!("Error listening to keyboard: {:?}", err);
        }
    });
}
```

Then call this from `setup`:

```rust
.setup(|app| {
    let handle = app.handle();
    let recording_state = Arc::new(RecordingState {
        is_recording: AtomicBool::new(false),
    });

    start_hotkey_listener(handle.clone(), recording_state);

    Ok(())
})
```

Later, to support right Alt, you check for `Key::AltRight` similarly and send separate events for testing.

---

## 4. Audio recording + waveform events

### 4.1 Audio capture design

Use `cpal`:

* On `start_audio_recording`:

  * Pick default input device and config.
  * Create input stream with callback.
  * In callback:

    * Append samples to an in-memory buffer (e.g., `Vec<f32>`).
    * Every N frames, compute RMS or peak amplitude & emit `"audio_level"` event to the frontend for visualization.

* On `stop_audio_and_transcribe`:

  * Stop the stream (store handle globally or in `Arc<Mutex<..>>`).
  * Take the buffer, convert to the format Whisper expects (e.g., mono 16 kHz float).
  * Feed to Whisper.

### 4.2 Implement basic audio capture state

You’ll need a shared struct, something like:

```rust
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};

struct AudioContext {
    stream: Option<cpal::Stream>,
    buffer: Vec<f32>,
}

type SharedAudio = Arc<Mutex<AudioContext>>;
```

Initialize in `setup`:

```rust
let audio_ctx = Arc::new(Mutex::new(AudioContext {
    stream: None,
    buffer: Vec::new(),
}));

// store in tauri state if needed
app.manage(audio_ctx.clone());
```

### 4.3 Start recording

Implementation sketch:

```rust
fn start_audio_recording(app: AppHandle) {
    let audio_ctx = app.state::<SharedAudio>().inner().clone();
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .expect("No input device available");
        let config = device
            .default_input_config()
            .expect("failed to get default input config");

        let sample_format = config.sample_format();
        let config = config.into();

        match sample_format {
            cpal::SampleFormat::F32 => build_input_stream::<f32>(device, config, audio_ctx, app),
            cpal::SampleFormat::I16 => build_input_stream::<i16>(device, config, audio_ctx, app),
            cpal::SampleFormat::U16 => build_input_stream::<u16>(device, config, audio_ctx, app),
        }
    });
}

fn build_input_stream<T>(
    device: cpal::Device,
    config: cpal::StreamConfig,
    audio_ctx: SharedAudio,
    app: AppHandle,
) where
    T: cpal::Sample,
{
    let channels = config.channels as usize;

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[T], _| {
                // Convert samples to f32 and store
                let mut ctx = audio_ctx.lock().unwrap();
                for frame in data.chunks(channels) {
                    let sample: f32 = frame[0].to_f32(); // first channel
                    ctx.buffer.push(sample);
                }

                // Compute a simple RMS for visualization (e.g. every callback)
                let rms = compute_rms(&ctx.buffer);
                let _ = app.emit_all("audio_level", rms);
            },
            move |err| {
                eprintln!("Audio input error: {:?}", err);
            },
        )
        .expect("failed to build input stream");

    stream.play().expect("failed to start input stream");

    // store the stream
    let mut ctx = audio_ctx.lock().unwrap();
    ctx.stream = Some(stream);
}

fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}
```

*(You might want a circular buffer for RMS instead of using the full buffer every time, but this is enough for another AI to optimize.)*

### 4.4 Stop recording and hand off to Whisper

```rust
fn stop_audio_and_transcribe(app: AppHandle) {
    let audio_ctx = app.state::<SharedAudio>().inner().clone();

    std::thread::spawn(move || {
        // Stop stream and copy buffer
        let buffer = {
            let mut ctx = audio_ctx.lock().unwrap();
            if let Some(stream) = ctx.stream.take() {
                drop(stream); // stops when dropped
            }
            let buf_copy = ctx.buffer.clone();
            ctx.buffer.clear();
            buf_copy
        };

        // Resample / pre-process if needed, then call whisper
        let text = run_whisper_on_buffer(&buffer);

        // handle clipboard + paste
        if let Some(t) = text {
            copy_to_clipboard_and_paste(&t);
            let _ = app.emit_all("transcription_done", &t);
        } else {
            let _ = app.emit_all("transcription_error", ());
        }
    });
}
```

---

## 5. Whisper integration (local model)

### 5.1 Model management

In the **frontend**, you’ll have:

* A text input or “Browse…” button to pick a model file (`.bin`).
* A dropdown or list of “Known models”.
* A “Set active model” button.

The chosen path is sent to Rust via a Tauri command, e.g. `set_active_model(path: String)`.

### 5.2 Rust side: load model once, reuse

In `main.rs`:

* Define a `WhisperContext` with a loaded model and a mutex.

```rust
use whisper_rs::WhisperContext;
use std::path::PathBuf;

struct WhisperState {
    ctx: Option<WhisperContext>,
    model_path: Option<PathBuf>,
}

type SharedWhisper = Arc<Mutex<WhisperState>>;
```

* Initialize in `setup`:

```rust
let whisper_state = Arc::new(Mutex::new(WhisperState {
    ctx: None,
    model_path: None,
}));
app.manage(whisper_state.clone());
```

### 5.3 Tauri command to set model

In `main.rs`, add:

```rust
#[tauri::command]
fn set_active_model(path: String, state: tauri::State<SharedWhisper>) -> Result<(), String> {
    let mut ws = state.lock().unwrap();
    let model_path = PathBuf::from(path.clone());
    let ctx = WhisperContext::new(&model_path).map_err(|e| e.to_string())?;
    ws.ctx = Some(ctx);
    ws.model_path = Some(model_path);
    Ok(())
}
```

Register this command in the builder:

```rust
.invoke_handler(tauri::generate_handler![set_active_model])
```

### 5.4 Transcribe function

Implementation idea for `run_whisper_on_buffer`:

* Ensure `WhisperState` has a loaded context.
* Downsample/convert audio to the format Whisper expects (e.g., 16 kHz mono float).
* Use `ctx.full()` or equivalent; read segments and concatenate text.

Pseudo-code:

```rust
fn run_whisper_on_buffer(samples: &[f32]) -> Option<String> {
    // TODO: resample to 16 kHz, etc.

    // Get Whisper context from state (passed as state param in real code)
    // For this outline, pretend we have it:
    let ctx: &mut whisper_rs::WhisperContext = /* ... */;

    let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_n_threads(4);

    // run inference
    ctx.full(params, samples).ok()?;

    let num_segments = ctx.full_n_segments();
    let mut out = String::new();
    for i in 0..num_segments {
        let seg = ctx.full_get_segment_text(i).unwrap_or_default();
        out.push_str(&seg);
    }
    Some(out.trim().to_owned())
}
```

The other AI can fill the missing pieces and wire `WhisperState` into this function.

---

## 6. Clipboard + simulate paste

### 6.1 Copy to clipboard

Use `arboard`:

```rust
use arboard::Clipboard;

fn copy_to_clipboard(text: &str) {
    if let Ok(mut clipboard) = Clipboard::new() {
        let _ = clipboard.set_text(text.to_string());
    }
}
```

### 6.2 Simulate Ctrl+V

You can use `rdev` again to simulate key presses:

```rust
use rdev::{simulate, Button, EventType as RdevEventType, Key as RdevKey};

fn simulate_ctrl_v() {
    let _ = simulate(RdevEventType::KeyPress(RdevKey::ControlLeft));
    let _ = simulate(RdevEventType::KeyPress(RdevKey::KeyV));
    let _ = simulate(RdevEventType::KeyRelease(RdevKey::KeyV));
    let _ = simulate(RdevEventType::KeyRelease(RdevKey::ControlLeft));
}

fn copy_to_clipboard_and_paste(text: &str) {
    copy_to_clipboard(text);
    simulate_ctrl_v();
}
```

This will paste into whatever window currently has focus (cursor position).

---

## 7. Frontend: overlay waveform + settings + hotkey test

### 7.1 React routing / layout

In `src/App.tsx` (or equivalent):

* Tabs/sections:

  * “Overlay” (or main screen) with waveform display.
  * “Model Settings”.
  * “Hotkey Test”.

Also, a small overlay window experience:

* The main window can be your settings UI.
* For overlay:

  * Either reuse main window but shrink and style it when recording.
  * Or create a second borderless window in Tauri config for overlay, but that’s more config. To keep it simple, have the main window show overlay state.

### 7.2 Listening to Tauri events

Use Tauri’s frontend API to listen for events:

```ts
import { listen } from "@tauri-apps/api/event";

useEffect(() => {
  const unlisteners: (() => void)[] = [];

  listen("recording_started", () => {
    setIsRecording(true);
  }).then(un => unlisteners.push(un));

  listen("recording_stopped", () => {
    setIsRecording(false);
  }).then(un => unlisteners.push(un));

  listen("audio_level", event => {
    const level = event.payload as number;
    setAudioLevel(level);
  }).then(un => unlisteners.push(un));

  listen("transcription_done", event => {
    const text = event.payload as string;
    setLastTranscript(text);
  }).then(un => unlisteners.push(un));

  return () => {
    unlisteners.forEach(un => un());
  };
}, []);
```

### 7.3 Waveform / level display

Simplest version: a single bar whose height is proportional to `audioLevel`.

```tsx
const WaveformOverlay: React.FC<{ level: number; isRecording: boolean }> = ({
  level,
  isRecording,
}) => {
  if (!isRecording) return null;

  const clamped = Math.min(Math.max(level, 0), 1);
  const barHeight = `${clamped * 100}%`;

  return (
    <div className="fixed bottom-4 right-4 w-64 h-24 bg-black/80 rounded-xl p-2 flex items-end">
      <div className="w-full bg-gray-800 rounded">
        <div
          className="bg-green-400 rounded"
          style={{ height: barHeight }}
        />
      </div>
    </div>
  );
};
```

### 7.4 Model management UI

* A text input for model path.
* A button that calls `set_active_model` Tauri command.
* Show status (success/error).

Example:

```ts
import { invoke } from "@tauri-apps/api/tauri";

const ModelSettings: React.FC = () => {
  const [modelPath, setModelPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const onSetModel = async () => {
    try {
      await invoke("set_active_model", { path: modelPath });
      setStatus("Model loaded");
    } catch (e: any) {
      setStatus(`Error: ${String(e)}`);
    }
  };

  return (
    <div>
      <h2>Model Settings</h2>
      <input
        value={modelPath}
        onChange={e => setModelPath(e.target.value)}
        placeholder="Path to whisper model .bin"
        className="border px-2 py-1 w-full"
      />
      <button onClick={onSetModel} className="mt-2 px-3 py-1 border rounded">
        Set active model
      </button>
      {status && <p className="mt-1 text-sm">{status}</p>}
    </div>
  );
};
```

You can later add a file picker using Tauri’s dialog API.

### 7.5 Hotkey test UI

* Show last pressed key from `rdev` events (you can emit `"hotkey_event"` from the Rust listener in addition to toggling).
* For example, when `Key::ControlRight` detected, emit payload `"RightCtrl"`; for `Key::AltRight`, `"RightAlt"`.

Frontend:

```ts
const HotkeyTest: React.FC = () => {
  const [lastKey, setLastKey] = useState<string>("(none)");

  useEffect(() => {
    const un = listen("hotkey_event", e => {
      setLastKey(e.payload as string);
    });
    return () => {
      un.then(f => f());
    };
  }, []);

  return (
    <div>
      <h2>Hotkey Test</h2>
      <p>Last detected key: {lastKey}</p>
      <p>Try pressing Right Ctrl / Right Alt.</p>
    </div>
  );
};
```

Rust side: in the `callback` for `rdev::listen`, emit:

```rust
let _ = app.emit_all("hotkey_event", "RightCtrl");
```

---

## 8. Minimizing to tray / behavior summary

At this point:

* App starts → main window is hidden, tray icon visible.
* User double-taps **Right Ctrl**:

  * 1st tap: `"recording_started"`, audio capture starts, overlay shows waveform.
  * 2nd tap: `"recording_stopped"`, audio stops, Whisper runs, text copied & pasted, overlay disappears.
* Main window:

  * Tray menu → “Show/Hide” toggles visibility.
  * Close button → hides window instead of quitting.

---

## 9. Build & run

For dev:

```bash
pnpm tauri dev
```

For production build:

```bash
pnpm tauri build
```

This will produce a Windows installer / executable with tray behavior.

---

If you’d like, next I can zoom into any one of these chunks (e.g., the Whisper buffer conversion, the exact `whisper-rs` transcription code, or a second overlay window) and write more concrete code that the “other AI” can just drop into the project.
