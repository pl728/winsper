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
    <div className="w-screen h-screen flex items-center justify-center bg-gradient-to-br from-zinc-900/95 to-zinc-950/95 backdrop-blur-xl rounded-2xl select-none relative">
      {/* Glow effect background */}
      <div className="absolute inset-0 flex items-center justify-center -z-10 blur-3xl opacity-30">
        {state === "recording" && (
          <div className="w-32 h-32 bg-cyan-500 rounded-full animate-pulse" />
        )}
        {state === "transcribing" && (
          <div className="w-32 h-32 bg-blue-500 rounded-full animate-pulse" />
        )}
        {state === "error" && (
          <div className="w-32 h-32 bg-yellow-500 rounded-full" />
        )}
        {state === "no_model" && (
          <div className="w-32 h-32 bg-orange-500 rounded-full" />
        )}
      </div>

      {/* Content with transition */}
      <div className="transition-all duration-300 ease-in-out">
        {state === "recording" && (
          <div className="flex items-center gap-4">
            <div className="relative">
              <AudioWaveform className="h-7 w-7 text-cyan-400 animate-pulse drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]" />
              <div className="absolute inset-0 h-7 w-7 rounded-full bg-cyan-400/20 animate-ping" />
            </div>
            <span className="text-base font-semibold text-white tracking-wide drop-shadow-lg">Listening...</span>
          </div>
        )}

        {state === "transcribing" && (
          <div className="flex items-center gap-4">
            <div className="relative">
              <Loader2 className="h-7 w-7 text-blue-400 animate-spin drop-shadow-[0_0_8px_rgba(96,165,250,0.6)]" />
              <div className="absolute inset-0 h-7 w-7 rounded-full bg-blue-400/20 animate-ping" />
            </div>
            <span className="text-base font-semibold text-white tracking-wide drop-shadow-lg">Transcribing...</span>
          </div>
        )}

        {state === "error" && (
          <div className="flex items-center gap-4">
            <AlertTriangle className="h-6 w-6 text-yellow-400 animate-pulse drop-shadow-[0_0_8px_rgba(250,204,21,0.6)]" />
            <span className="text-base font-semibold text-white max-w-[280px] truncate drop-shadow-lg">
              {errorMessage || "Error occurred"}
            </span>
          </div>
        )}

        {state === "no_model" && (
          <div className="flex items-center gap-4">
            <XCircle className="h-6 w-6 text-orange-400 drop-shadow-[0_0_8px_rgba(251,146,60,0.6)]" />
            <span className="text-base font-semibold text-white drop-shadow-lg">No model selected</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default Overlay;
