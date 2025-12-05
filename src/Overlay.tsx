import { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { AudioWaveform, Loader2, AlertTriangle, XCircle } from "lucide-react";

type OverlayState = "recording" | "transcribing" | "error" | "no_model" | "idle";

function Overlay() {
  // Default to "recording" since that's the most common reason to show the overlay
  const [state, setState] = useState<OverlayState>("recording");
  const [errorMessage, setErrorMessage] = useState("");
  const listenersReady = useRef(false);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    // Set up all listeners
    const setupListeners = async () => {
      unlisteners.push(await listen("recording_started", () => {
        console.log("[Overlay] Received recording_started");
        setState("recording");
        setErrorMessage("");
      }));

      unlisteners.push(await listen("recording_stopped", () => {
        console.log("[Overlay] Received recording_stopped");
        // Will switch to transcribing
      }));

      unlisteners.push(await listen("transcription_started", () => {
        console.log("[Overlay] Received transcription_started");
        setState("transcribing");
      }));

      unlisteners.push(await listen("transcription_done", () => {
        console.log("[Overlay] Received transcription_done");
        setState("idle");
      }));

      unlisteners.push(await listen("transcription_error", (event) => {
        console.log("[Overlay] Received transcription_error");
        setState("error");
        setErrorMessage(event.payload as string);
      }));

      unlisteners.push(await listen("no_model_selected", () => {
        console.log("[Overlay] Received no_model_selected");
        setState("no_model");
      }));

      // Mark listeners as ready
      listenersReady.current = true;
      console.log("[Overlay] All listeners ready");
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
          <Loader2 className="h-5 w-5 text-cyan-400 animate-spin" />
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
