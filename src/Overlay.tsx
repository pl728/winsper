import { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AudioWaveform, Loader2, AlertTriangle, XCircle } from "lucide-react";

type OverlayState = "recording" | "transcribing" | "error" | "no_model" | "idle";

function Overlay() {
  // Default to "recording" since that's the most common reason to show the overlay
  const [state, setState] = useState<OverlayState>("recording");
  const [errorMessage, setErrorMessage] = useState("");
  const listenersReady = useRef(false);

  // Log state changes
  useEffect(() => {
    console.log("[Overlay] State changed to:", state);
  }, [state]);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    // Set up all listeners - use both global and window-specific listeners
    const setupListeners = async () => {
      const window = getCurrentWindow();

      // Global listeners (for events broadcast via app.emit)
      unlisteners.push(await listen("recording_started", () => {
        console.log("[Overlay] Received recording_started (global)");
        setState("recording");
        setErrorMessage("");
      }));

      unlisteners.push(await listen("recording_stopped", () => {
        console.log("[Overlay] Received recording_stopped (global)");
      }));

      unlisteners.push(await listen("transcription_started", () => {
        console.log("[Overlay] Received transcription_started (global)");
        setState("transcribing");
      }));

      unlisteners.push(await listen("transcription_done", () => {
        console.log("[Overlay] Received transcription_done (global)");
        setState("idle");
      }));

      unlisteners.push(await listen("transcription_error", (event) => {
        console.log("[Overlay] Received transcription_error (global)");
        setState("error");
        setErrorMessage(event.payload as string);
      }));

      unlisteners.push(await listen("no_model_selected", () => {
        console.log("[Overlay] Received no_model_selected (global)");
        setState("no_model");
      }));

      // Window-specific listeners (for events sent via window.emit)
      unlisteners.push(await window.listen("transcription_started", () => {
        console.log("[Overlay] Received transcription_started (window-specific)");
        setState("transcribing");
      }));

      unlisteners.push(await window.listen("transcription_done", () => {
        console.log("[Overlay] Received transcription_done (window-specific)");
        setState("idle");
      }));

      unlisteners.push(await window.listen("transcription_error", (event) => {
        console.log("[Overlay] Received transcription_error (window-specific)");
        setState("error");
        setErrorMessage(event.payload as string);
      }));

      // Mark listeners as ready
      listenersReady.current = true;
      console.log("[Overlay] All listeners ready (global + window-specific)");
    };

    setupListeners();

    return () => {
      unlisteners.forEach((un) => un());
    };
  }, []);

  return (
    <div className="w-screen h-screen flex items-center justify-center bg-zinc-900/95 backdrop-blur-xl rounded-2xl select-none">
      {state === "recording" && (
        <div className="flex items-center gap-3">
          <AudioWaveform className="h-6 w-6 text-cyan-400 animate-pulse" />
          <span className="text-sm font-medium text-white/90">Speak...</span>
        </div>
      )}

      {state === "transcribing" && (
        <div className="flex items-center gap-3">
          <div className="relative">
            <Loader2 className="h-6 w-6 text-cyan-400 animate-spin" />
            <div className="absolute inset-0 h-6 w-6 rounded-full bg-cyan-400/20 animate-ping" />
          </div>
          <span className="text-sm font-medium text-white/90">Transcribing...</span>
        </div>
      )}

      {state === "error" && (
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-yellow-400" />
          <span className="text-sm font-medium text-white/90 max-w-[200px] truncate">
            {errorMessage || "Error"}
          </span>
        </div>
      )}

      {state === "no_model" && (
        <div className="flex items-center gap-3">
          <XCircle className="h-5 w-5 text-orange-400" />
          <span className="text-sm font-medium text-white/90">No model selected</span>
        </div>
      )}
    </div>
  );
}

export default Overlay;
