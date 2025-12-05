use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use arboard::Clipboard;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Sample;
use futures_util::StreamExt;
use rdev::{listen, simulate, Event, EventType, Key};
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent,
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Preset model definition
#[derive(Clone, Serialize)]
pub struct PresetModel {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub size: String,
    pub url: String,
}

/// Model info returned to frontend
#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub size: String,
    pub downloaded: bool,
    pub active: bool,
}

/// Get list of preset models
fn get_preset_models() -> Vec<PresetModel> {
    vec![
        PresetModel {
            id: "tiny.en".to_string(),
            name: "Tiny (English)".to_string(),
            filename: "ggml-tiny.en.bin".to_string(),
            size: "75 MB".to_string(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin".to_string(),
        },
        PresetModel {
            id: "base.en".to_string(),
            name: "Base (English)".to_string(),
            filename: "ggml-base.en.bin".to_string(),
            size: "142 MB".to_string(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin".to_string(),
        },
        PresetModel {
            id: "small.en".to_string(),
            name: "Small (English)".to_string(),
            filename: "ggml-small.en.bin".to_string(),
            size: "466 MB".to_string(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin".to_string(),
        },
        PresetModel {
            id: "medium.en".to_string(),
            name: "Medium (English)".to_string(),
            filename: "ggml-medium.en.bin".to_string(),
            size: "1.5 GB".to_string(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin".to_string(),
        },
    ]
}

/// Shared state for tracking recording status
pub struct RecordingState {
    pub is_recording: AtomicBool,
    pub is_processing: AtomicBool,  // True while transcription is in progress
}

/// Audio context holding captured samples (stream is kept local to recording thread)
pub struct AudioContext {
    pub buffer: Vec<f32>,
    pub sample_rate: u32,
    pub stop_signal: Arc<AtomicBool>,
}

pub type SharedAudio = Arc<Mutex<AudioContext>>;

/// Whisper context state for transcription
pub struct WhisperState {
    pub ctx: Option<WhisperContext>,
    pub model_path: Option<PathBuf>,
}

pub type SharedWhisper = Arc<Mutex<WhisperState>>;

/// Computes the RMS (root mean square) of the last N samples for waveform visualization
fn compute_rms(samples: &[f32], window_size: usize) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let start = if samples.len() > window_size {
        samples.len() - window_size
    } else {
        0
    };
    let window = &samples[start..];
    let sum_sq: f32 = window.iter().map(|s| s * s).sum();
    (sum_sq / window.len() as f32).sqrt()
}

/// Resamples audio from source_rate to 16kHz (required by Whisper)
fn resample_to_16khz(samples: &[f32], source_rate: u32) -> Result<Vec<f32>, String> {
    const TARGET_RATE: u32 = 16000;
    
    if source_rate == TARGET_RATE {
        return Ok(samples.to_vec());
    }
    
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    
    let mut resampler = SincFixedIn::<f32>::new(
        TARGET_RATE as f64 / source_rate as f64,
        2.0, // max relative ratio (not used for fixed ratio)
        params,
        samples.len(),
        1, // mono
    ).map_err(|e| format!("Failed to create resampler: {:?}", e))?;
    
    let waves_in = vec![samples.to_vec()];
    let waves_out = resampler.process(&waves_in, None)
        .map_err(|e| format!("Resampling failed: {:?}", e))?;
    
    Ok(waves_out.into_iter().next().unwrap_or_default())
}

/// Runs Whisper transcription on the audio buffer
fn run_whisper_on_buffer(
    samples: &[f32],
    sample_rate: u32,
    whisper_state: &SharedWhisper,
) -> Result<String, String> {
    // Resample to 16kHz
    let resampled = resample_to_16khz(samples, sample_rate)?;
    
    println!("[Whisper] Resampled {} samples at {}Hz to {} samples at 16kHz", 
             samples.len(), sample_rate, resampled.len());
    
    // Get Whisper context
    let ws = whisper_state.lock().map_err(|e| format!("Lock error: {:?}", e))?;
    let ctx = ws.ctx.as_ref().ok_or("No Whisper model loaded. Please set a model first.")?;
    
    // Create Whisper state for this transcription
    let mut state = ctx.create_state().map_err(|e| format!("Failed to create state: {:?}", e))?;
    
    // Configure parameters
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_n_threads(4);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    
    // Run inference
    println!("[Whisper] Starting transcription...");
    state.full(params, &resampled)
        .map_err(|e| format!("Transcription failed: {:?}", e))?;
    
    // Collect segments
    let num_segments = state.full_n_segments()
        .map_err(|e| format!("Failed to get segments: {:?}", e))?;
    
    let mut result = String::new();
    for i in 0..num_segments {
        if let Ok(segment) = state.full_get_segment_text(i) {
            result.push_str(&segment);
        }
    }
    
    let text = result.trim().to_string();
    println!("[Whisper] Transcription complete: \"{}\"", text);
    
    Ok(text)
}

/// Copies text to the system clipboard
fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("Failed to access clipboard: {:?}", e))?;
    clipboard.set_text(text.to_string()).map_err(|e| format!("Failed to set clipboard text: {:?}", e))?;
    println!("[Clipboard] Text copied: \"{}\"", text);
    Ok(())
}

/// Simulates Ctrl+V keystroke to paste from clipboard
fn simulate_paste() -> Result<(), String> {
    // Small delay to ensure the target window is ready
    std::thread::sleep(std::time::Duration::from_millis(50));
    
    // Press Ctrl
    simulate(&EventType::KeyPress(Key::ControlLeft))
        .map_err(|e| format!("Failed to press Ctrl: {:?}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(20));
    
    // Press V
    simulate(&EventType::KeyPress(Key::KeyV))
        .map_err(|e| format!("Failed to press V: {:?}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(20));
    
    // Release V
    simulate(&EventType::KeyRelease(Key::KeyV))
        .map_err(|e| format!("Failed to release V: {:?}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(20));
    
    // Release Ctrl
    simulate(&EventType::KeyRelease(Key::ControlLeft))
        .map_err(|e| format!("Failed to release Ctrl: {:?}", e))?;
    
    println!("[Paste] Simulated Ctrl+V");
    Ok(())
}

/// Copies text to clipboard and simulates paste
fn copy_to_clipboard_and_paste(text: &str) -> Result<(), String> {
    copy_to_clipboard(text)?;
    simulate_paste()?;
    Ok(())
}

/// Shows the overlay window and positions it at the bottom center of the screen
fn show_overlay(app: &AppHandle) {
    println!("[Overlay] Attempting to show overlay...");
    if let Some(overlay) = app.get_webview_window("overlay") {
        // Get the primary monitor (more reliable than current_monitor for hidden windows)
        let monitor = overlay.primary_monitor()
            .ok()
            .flatten()
            .or_else(|| overlay.current_monitor().ok().flatten());
        
        if let Some(monitor) = monitor {
            let screen_size = monitor.size();
            let screen_pos = monitor.position();
            
            // Get overlay window size
            if let Ok(overlay_size) = overlay.outer_size() {
                // Calculate position: horizontally centered, near the bottom
                let x = screen_pos.x + (screen_size.width as i32 - overlay_size.width as i32) / 2;
                let y = screen_pos.y + screen_size.height as i32 - overlay_size.height as i32 - 100; // 100px from bottom
                
                let _ = overlay.set_position(PhysicalPosition::new(x, y));
                println!("[Overlay] Positioned at ({}, {})", x, y);
            }
        }
        
        let _ = overlay.show();
        println!("[Overlay] Window shown");
        // Don't set focus - this would steal keyboard events from rdev
        // The overlay is just a visual indicator
    } else {
        println!("[Overlay] ERROR: Could not find overlay window!");
    }
}

/// Hides the overlay window
fn hide_overlay(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
}

/// Starts audio recording using the default input device
fn start_audio_recording(app: AppHandle, audio_ctx: SharedAudio) {
    // Get the stop signal before spawning thread
    let stop_signal = {
        let ctx = audio_ctx.lock().unwrap();
        ctx.stop_signal.store(false, Ordering::SeqCst);
        ctx.stop_signal.clone()
    };

    std::thread::spawn(move || {
        let host = cpal::default_host();
        
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                eprintln!("[Audio] No input device available");
                let _ = app.emit("audio_error", "No input device available");
                return;
            }
        };

        println!("[Audio] Using input device: {}", device.name().unwrap_or_default());

        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[Audio] Failed to get default input config: {:?}", e);
                let _ = app.emit("audio_error", format!("Failed to get input config: {:?}", e));
                return;
            }
        };

        println!("[Audio] Default input config: {:?}", config);

        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;

        // Update sample rate in context and clear buffer
        {
            let mut ctx = audio_ctx.lock().unwrap();
            ctx.sample_rate = sample_rate;
            ctx.buffer.clear();
        }

        let audio_ctx_clone = audio_ctx.clone();
        let app_clone = app.clone();

        // Counter for throttling audio_level events
        let sample_count = Arc::new(Mutex::new(0usize));
        let sample_count_clone = sample_count.clone();

        let err_fn = |err| eprintln!("[Audio] Stream error: {:?}", err);

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mut ctx = audio_ctx_clone.lock().unwrap();
                        
                        // Convert to mono by averaging channels
                        for frame in data.chunks(channels) {
                            let sample: f32 = frame.iter().sum::<f32>() / channels as f32;
                            ctx.buffer.push(sample);
                        }

                        // Throttle audio_level events: emit every ~2048 samples
                        let mut count = sample_count_clone.lock().unwrap();
                        *count += data.len() / channels;
                        
                        if *count >= 2048 {
                            let rms = compute_rms(&ctx.buffer, 4096);
                            // Normalize RMS to 0-1 range (typical speech is ~0.01-0.1 RMS)
                            let normalized = (rms * 10.0).min(1.0);
                            let _ = app_clone.emit("audio_level", normalized);
                            *count = 0;
                        }
                    },
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let mut ctx = audio_ctx_clone.lock().unwrap();
                        
                        for frame in data.chunks(channels) {
                            let sample: f32 = frame.iter()
                                .map(|s| s.to_float_sample())
                                .sum::<f32>() / channels as f32;
                            ctx.buffer.push(sample);
                        }

                        let mut count = sample_count_clone.lock().unwrap();
                        *count += data.len() / channels;
                        
                        if *count >= 2048 {
                            let rms = compute_rms(&ctx.buffer, 4096);
                            let normalized = (rms * 10.0).min(1.0);
                            let _ = app_clone.emit("audio_level", normalized);
                            *count = 0;
                        }
                    },
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                device.build_input_stream(
                    &config.into(),
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let mut ctx = audio_ctx_clone.lock().unwrap();
                        
                        for frame in data.chunks(channels) {
                            let sample: f32 = frame.iter()
                                .map(|s| s.to_float_sample())
                                .sum::<f32>() / channels as f32;
                            ctx.buffer.push(sample);
                        }

                        let mut count = sample_count_clone.lock().unwrap();
                        *count += data.len() / channels;
                        
                        if *count >= 2048 {
                            let rms = compute_rms(&ctx.buffer, 4096);
                            let normalized = (rms * 10.0).min(1.0);
                            let _ = app_clone.emit("audio_level", normalized);
                            *count = 0;
                        }
                    },
                    err_fn,
                    None,
                )
            }
            _ => {
                eprintln!("[Audio] Unsupported sample format");
                let _ = app.emit("audio_error", "Unsupported sample format");
                return;
            }
        };

        match stream {
            Ok(s) => {
                if let Err(e) = s.play() {
                    eprintln!("[Audio] Failed to start stream: {:?}", e);
                    let _ = app.emit("audio_error", format!("Failed to start stream: {:?}", e));
                    return;
                }
                
                println!("[Audio] Recording started");
                
                // Keep the stream alive until stop signal is set
                // The stream is kept in this thread (not shared) to avoid Send/Sync issues
                while !stop_signal.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                
                // Stream is dropped here when we exit the loop
                println!("[Audio] Stream stopped");
            }
            Err(e) => {
                eprintln!("[Audio] Failed to build input stream: {:?}", e);
                let _ = app.emit("audio_error", format!("Failed to build stream: {:?}", e));
            }
        }
    });
}

/// Stops audio recording and runs Whisper transcription
fn stop_audio_recording(
    app: AppHandle, 
    audio_ctx: SharedAudio, 
    whisper_state: SharedWhisper,
    recording_state: Arc<RecordingState>,
) {
    // Signal the recording thread to stop
    {
        let ctx = audio_ctx.lock().unwrap();
        ctx.stop_signal.store(true, Ordering::SeqCst);
    }
    
    // Mark as processing (transcription in progress)
    recording_state.is_processing.store(true, Ordering::SeqCst);
    
    // Give a brief moment for the stream to stop
    std::thread::sleep(std::time::Duration::from_millis(100));
    
    std::thread::spawn(move || {
        // Copy buffer and get sample rate
        let (buffer, sample_rate) = {
            let mut ctx = audio_ctx.lock().unwrap();
            let buf = ctx.buffer.clone();
            let rate = ctx.sample_rate;
            ctx.buffer.clear(); // Clear buffer for next recording
            (buf, rate)
        };
        
        let duration = buffer.len() as f32 / sample_rate as f32;
        println!("[Audio] Recording stopped. Captured {} samples at {} Hz ({:.2} seconds)", 
                 buffer.len(), sample_rate, duration);

        // Emit recording stats
        let _ = app.emit("recording_complete", serde_json::json!({
            "samples": buffer.len(),
            "sample_rate": sample_rate,
            "duration_seconds": duration
        }));
        
        // Run Whisper transcription - emit to overlay window specifically
        println!("[Transcription] Emitting transcription_started event");
        if let Some(overlay) = app.get_webview_window("overlay") {
            match overlay.emit("transcription_started", ()) {
                Ok(_) => println!("[Transcription] transcription_started sent to overlay"),
                Err(e) => println!("[Transcription] Failed to emit to overlay: {:?}", e),
            }
        } else {
            println!("[Transcription] WARNING: overlay window not found");
        }
        // Also broadcast to all windows for the main app
        let _ = app.emit("transcription_started", ());
        
        match run_whisper_on_buffer(&buffer, sample_rate, &whisper_state) {
            Ok(text) => {
                if text.is_empty() {
                    let _ = app.emit("transcription_error", "No speech detected");
                    // Hide overlay after a brief delay so user sees the error
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    hide_overlay(&app);
                } else if text == "[BLANK_AUDIO]" {
                    // Skip blank audio - don't paste anything
                    println!("[Whisper] Blank audio detected, skipping paste");
                    let _ = app.emit("transcription_error", "No speech detected");
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    hide_overlay(&app);
                } else {
                    // Copy to clipboard and paste
                    match copy_to_clipboard_and_paste(&text) {
                        Ok(()) => {
                            let _ = app.emit("transcription_done", &text);
                        }
                        Err(e) => {
                            eprintln!("[Clipboard/Paste] Error: {}", e);
                            // Still emit transcription_done since we got the text
                            let _ = app.emit("transcription_done", &text);
                            let _ = app.emit("paste_error", e);
                        }
                    }
                    // Hide overlay after transcription is done
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    hide_overlay(&app);
                }
            }
            Err(e) => {
                eprintln!("[Whisper] Error: {}", e);
                let _ = app.emit("transcription_error", e);
                // Hide overlay after a brief delay so user sees the error
                std::thread::sleep(std::time::Duration::from_millis(1500));
                hide_overlay(&app);
            }
        }
        
        // Mark processing as complete
        recording_state.is_processing.store(false, Ordering::SeqCst);
    });
}

/// Starts a background thread that listens for global keyboard events.
/// Detects Right Ctrl key presses to toggle recording state.
fn start_hotkey_listener(
    app: AppHandle, 
    recording_state: Arc<RecordingState>, 
    audio_ctx: SharedAudio,
    whisper_state: SharedWhisper,
) {
    std::thread::spawn(move || {
        let callback = move |event: Event| {
            if let EventType::KeyPress(key) = event.event_type {
                match key {
                    Key::ControlLeft => {
                        // Emit hotkey event for testing UI (left ctrl doesn't trigger recording)
                        let _ = app.emit("hotkey_event", "LeftCtrl");
                    }
                    Key::ControlRight => {
                        // Emit hotkey event for testing UI
                        let _ = app.emit("hotkey_event", "RightCtrl");

                        let currently_recording = recording_state.is_recording.load(Ordering::SeqCst);
                        let currently_processing = recording_state.is_processing.load(Ordering::SeqCst);

                        // Don't start a new recording if we're still processing the previous one
                        if currently_processing && !currently_recording {
                            println!("[Hotkey] Ignoring - still processing previous transcription");
                            return;
                        }

                        if !currently_recording {
                            // Check if a model is loaded before starting recording
                            let model_loaded = whisper_state.lock()
                                .map(|ws| ws.ctx.is_some())
                                .unwrap_or(false);
                            
                            if !model_loaded {
                                // Show "no model" message and auto-hide
                                println!("[Hotkey] No model loaded, cannot start recording");
                                
                                let app_clone = app.clone();
                                std::thread::spawn(move || {
                                    show_overlay(&app_clone);
                                    // Give React time to mount component and set up listeners
                                    std::thread::sleep(std::time::Duration::from_millis(200));
                                    println!("[Hotkey] Emitting no_model_selected event");
                                    let _ = app_clone.emit("no_model_selected", ());
                                    std::thread::sleep(std::time::Duration::from_millis(2000));
                                    hide_overlay(&app_clone);
                                });
                                return;
                            }
                            
                            // Start recording
                            recording_state.is_recording.store(true, Ordering::SeqCst);
                            println!("[Hotkey] Recording started");
                            
                            // Show overlay window first, then emit event after a delay
                            // so React has time to mount and set up event listeners
                            let app_clone = app.clone();
                            let audio_ctx_clone = audio_ctx.clone();
                            std::thread::spawn(move || {
                                show_overlay(&app_clone);
                                // Emit recording_started immediately so UI resets to recording state
                                println!("[Hotkey] Emitting recording_started event");
                                let _ = app_clone.emit("recording_started", ());
                                
                                // Start audio capture
                                start_audio_recording(app_clone, audio_ctx_clone);
                            });
                        } else {
                            // Stop recording
                            recording_state.is_recording.store(false, Ordering::SeqCst);
                            let _ = app.emit("recording_stopped", ());
                            println!("[Hotkey] Recording stopped");
                            
                            // Stop audio capture and run transcription
                            // (overlay will be hidden after transcription completes)
                            stop_audio_recording(
                                app.clone(), 
                                audio_ctx.clone(), 
                                whisper_state.clone(),
                                recording_state.clone(),
                            );
                        }
                    }
                    Key::Alt => {
                        // Emit hotkey event for testing UI (future use)
                        // Note: rdev doesn't distinguish left/right Alt on all platforms
                        let _ = app.emit("hotkey_event", "Alt");
                    }
                    _ => {}
                }
            }
        };

        if let Err(err) = listen(callback) {
            eprintln!("Error listening to keyboard: {:?}", err);
        }
    });
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Tauri command to set the active Whisper model
#[tauri::command]
fn set_active_model(path: String, state: tauri::State<SharedWhisper>) -> Result<String, String> {
    println!("[Whisper] Loading model from: {}", path);
    
    let model_path = PathBuf::from(&path);
    
    if !model_path.exists() {
        return Err(format!("Model file not found: {}", path));
    }
    
    // Load the Whisper context
    let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load Whisper model: {:?}", e))?;
    
    // Store in state
    let mut ws = state.lock().map_err(|e| format!("Lock error: {:?}", e))?;
    ws.ctx = Some(ctx);
    ws.model_path = Some(model_path);
    
    println!("[Whisper] Model loaded successfully");
    
    Ok(format!("Model loaded: {}", path))
}

/// Tauri command to get current model path
#[tauri::command]
fn get_active_model(state: tauri::State<SharedWhisper>) -> Option<String> {
    let ws = state.lock().ok()?;
    ws.model_path.as_ref().map(|p| p.to_string_lossy().to_string())
}

/// Get the models directory path
fn get_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {:?}", e))?;
    let models_dir = app_data_dir.join("models");
    
    // Create directory if it doesn't exist
    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir)
            .map_err(|e| format!("Failed to create models directory: {:?}", e))?;
    }
    
    Ok(models_dir)
}

/// Get the config file path
fn get_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {:?}", e))?;
    
    // Create directory if it doesn't exist
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {:?}", e))?;
    }
    
    Ok(app_data_dir.join("config.json"))
}

/// Save the selected model ID to config
fn save_selected_model(app: &AppHandle, model_id: &str) -> Result<(), String> {
    let config_path = get_config_path(app)?;
    let config = serde_json::json!({
        "selected_model": model_id
    });
    
    std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to save config: {:?}", e))?;
    
    println!("[Config] Saved selected model: {}", model_id);
    Ok(())
}

/// Load the selected model ID from config
fn load_selected_model(app: &AppHandle) -> Option<String> {
    let config_path = get_config_path(app).ok()?;
    
    if !config_path.exists() {
        return None;
    }
    
    let contents = std::fs::read_to_string(&config_path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&contents).ok()?;
    
    config.get("selected_model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Auto-load the previously selected model on startup
fn auto_load_model(app: &AppHandle, whisper_state: &SharedWhisper) {
    if let Some(model_id) = load_selected_model(app) {
        println!("[Startup] Found saved model: {}", model_id);
        
        let presets = get_preset_models();
        if let Some(preset) = presets.iter().find(|p| p.id == model_id) {
            if let Ok(models_dir) = get_models_dir(app) {
                let model_path = models_dir.join(&preset.filename);
                
                if model_path.exists() {
                    let path_str = model_path.to_string_lossy().to_string();
                    println!("[Startup] Auto-loading model from: {}", path_str);
                    
                    match WhisperContext::new_with_params(&path_str, WhisperContextParameters::default()) {
                        Ok(ctx) => {
                            if let Ok(mut ws) = whisper_state.lock() {
                                ws.ctx = Some(ctx);
                                ws.model_path = Some(model_path);
                                println!("[Startup] Model loaded successfully: {}", preset.name);
                            }
                        }
                        Err(e) => {
                            eprintln!("[Startup] Failed to load model: {:?}", e);
                        }
                    }
                } else {
                    println!("[Startup] Saved model not downloaded: {}", preset.filename);
                }
            }
        }
    }
}

/// Tauri command to list all preset models with their status
#[tauri::command]
fn list_models(app: AppHandle, whisper_state: tauri::State<SharedWhisper>) -> Result<Vec<ModelInfo>, String> {
    let models_dir = get_models_dir(&app)?;
    let presets = get_preset_models();
    
    let active_path = whisper_state.lock()
        .ok()
        .and_then(|ws| ws.model_path.clone());
    
    let models: Vec<ModelInfo> = presets.iter().map(|preset| {
        let model_path = models_dir.join(&preset.filename);
        let downloaded = model_path.exists();
        let active = active_path.as_ref().map_or(false, |p| p == &model_path);
        
        ModelInfo {
            id: preset.id.clone(),
            name: preset.name.clone(),
            filename: preset.filename.clone(),
            size: preset.size.clone(),
            downloaded,
            active,
        }
    }).collect();
    
    Ok(models)
}

/// Tauri command to download a model
#[tauri::command]
async fn download_model(app: AppHandle, model_id: String) -> Result<String, String> {
    let presets = get_preset_models();
    let preset = presets.iter()
        .find(|p| p.id == model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?
        .clone();
    
    let models_dir = get_models_dir(&app)?;
    let model_path = models_dir.join(&preset.filename);
    
    // Check if already downloaded
    if model_path.exists() {
        return Ok(format!("Model already downloaded: {}", preset.filename));
    }
    
    println!("[Download] Starting download of {} from {}", preset.filename, preset.url);
    let _ = app.emit("download_started", &model_id);
    
    // Download the file
    let client = reqwest::Client::new();
    let response = client.get(&preset.url)
        .send()
        .await
        .map_err(|e| format!("Failed to start download: {:?}", e))?;
    
    let total_size = response.content_length().unwrap_or(0);
    
    // Create temp file
    let temp_path = model_path.with_extension("tmp");
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {:?}", e))?;
    
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {:?}", e))?;
        
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("Failed to write chunk: {:?}", e))?;
        
        downloaded += chunk.len() as u64;
        
        // Emit progress (throttled to avoid too many events)
        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64 * 100.0) as u32;
            let _ = app.emit("download_progress", serde_json::json!({
                "model_id": model_id,
                "progress": progress,
                "downloaded": downloaded,
                "total": total_size
            }));
        }
    }
    
    // Rename temp file to final path
    tokio::fs::rename(&temp_path, &model_path)
        .await
        .map_err(|e| format!("Failed to rename temp file: {:?}", e))?;
    
    println!("[Download] Completed: {}", preset.filename);
    let _ = app.emit("download_complete", &model_id);
    
    Ok(format!("Downloaded: {}", preset.filename))
}

/// Tauri command to load a model by ID
#[tauri::command]
fn load_model(app: AppHandle, model_id: String, state: tauri::State<SharedWhisper>) -> Result<String, String> {
    let presets = get_preset_models();
    let preset = presets.iter()
        .find(|p| p.id == model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;
    
    let models_dir = get_models_dir(&app)?;
    let model_path = models_dir.join(&preset.filename);
    
    if !model_path.exists() {
        return Err(format!("Model not downloaded: {}", preset.filename));
    }
    
    let path_str = model_path.to_string_lossy().to_string();
    println!("[Whisper] Loading model from: {}", path_str);
    
    // Load the Whisper context
    let ctx = WhisperContext::new_with_params(&path_str, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load Whisper model: {:?}", e))?;
    
    // Store in state
    let mut ws = state.lock().map_err(|e| format!("Lock error: {:?}", e))?;
    ws.ctx = Some(ctx);
    ws.model_path = Some(model_path);
    
    // Save the selection to config
    let _ = save_selected_model(&app, &model_id);
    
    println!("[Whisper] Model loaded successfully: {}", preset.name);
    
    Ok(format!("Loaded: {}", preset.name))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![greet, set_active_model, get_active_model, list_models, download_model, load_model])
        .setup(|app| {
            // Initialize recording state
            let recording_state = Arc::new(RecordingState {
                is_recording: AtomicBool::new(false),
                is_processing: AtomicBool::new(false),
            });
            
            // Initialize audio context
            let audio_ctx: SharedAudio = Arc::new(Mutex::new(AudioContext {
                buffer: Vec::new(),
                sample_rate: 44100, // Default, will be updated when recording starts
                stop_signal: Arc::new(AtomicBool::new(false)),
            }));
            
            // Initialize Whisper state (model loaded via set_active_model command)
            let whisper_state: SharedWhisper = Arc::new(Mutex::new(WhisperState {
                ctx: None,
                model_path: None,
            }));
            
            // Manage whisper state so it can be accessed by commands
            app.manage(whisper_state.clone());
            
            // Auto-load previously selected model
            auto_load_model(app.handle(), &whisper_state);
            
            // Start hotkey listener with audio context and whisper state
            start_hotkey_listener(app.handle().clone(), recording_state, audio_ctx, whisper_state);

            // Build the tray menu
            let show_hide = MenuItem::with_id(app, "show_hide", "Show/Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_hide, &quit])?;

            // Build the tray icon
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Show window on left click
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide window instead of closing
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
