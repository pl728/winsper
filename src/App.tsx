import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Layers, Settings, Circle, Download, Check, Loader2, Power, Mic } from "lucide-react";
import "@/index.css";

type Tab = "model" | "settings";

interface ModelInfo {
  id: string;
  name: string;
  filename: string;
  size: string;
  downloaded: boolean;
  active: boolean;
}

interface AudioDeviceInfo {
  id: string;
  name: string;
  is_default: boolean;
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("model");

  // Model state
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModel, setLoadingModel] = useState<string | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);

  // Settings state
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([]);
  const [selectedMicrophone, setSelectedMicrophone] = useState<string | null>(null);

  // Load models list
  const refreshModels = async () => {
    try {
      const modelList = await invoke<ModelInfo[]>("list_models");
      setModels(modelList);
    } catch (e) {
      console.error("Failed to list models:", e);
    }
  };

  // Load audio devices list
  const refreshAudioDevices = async () => {
    try {
      const devices = await invoke<AudioDeviceInfo[]>("list_audio_devices");
      setAudioDevices(devices);
    } catch (e) {
      console.error("Failed to list audio devices:", e);
    }
  };

  // Load initial state
  useEffect(() => {
    refreshModels();
    refreshAudioDevices();
    // Load autostart setting
    invoke<boolean>("get_autostart_enabled")
      .then(setAutoStartEnabled)
      .catch(console.error);
    // Load selected microphone
    invoke<string | null>("get_selected_microphone")
      .then(setSelectedMicrophone)
      .catch(console.error);
  }, []);

  // Listen for Tauri events
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    // Download events
    listen<string>("download_started", (event) => {
      setDownloadingModel(event.payload);
      setDownloadProgress(0);
    }).then((un) => unlisteners.push(un));

    listen<{ model_id: string; progress: number }>("download_progress", (event) => {
      setDownloadProgress(event.payload.progress);
    }).then((un) => unlisteners.push(un));

    listen<string>("download_complete", () => {
      setDownloadingModel(null);
      setDownloadProgress(0);
      refreshModels();
    }).then((un) => unlisteners.push(un));

    return () => {
      unlisteners.forEach((un) => un());
    };
  }, []);

  const handleDownload = async (modelId: string) => {
    try {
      setDownloadingModel(modelId);
      await invoke("download_model", { modelId });
    } catch (e) {
      console.error("Failed to download:", e);
      setDownloadingModel(null);
    }
  };

  const handleLoad = async (modelId: string) => {
    try {
      setLoadingModel(modelId);
      await invoke("load_model", { modelId });
      await refreshModels();
    } catch (e) {
      console.error("Failed to load model:", e);
    } finally {
      setLoadingModel(null);
    }
  };

  const handleAutoStartToggle = async (enabled: boolean) => {
    try {
      await invoke("set_autostart_enabled", { enabled });
      setAutoStartEnabled(enabled);
    } catch (e) {
      console.error("Failed to set autostart:", e);
    }
  };

  const handleMicrophoneChange = async (value: string) => {
    try {
      const deviceName = value === "default" ? null : value;
      await invoke("set_selected_microphone", { deviceName });
      setSelectedMicrophone(deviceName);
    } catch (e) {
      console.error("Failed to set microphone:", e);
    }
  };

  const activeModel = models.find((m) => m.active);
  const defaultDevice = audioDevices.find((d) => d.is_default);
  const currentMicName = selectedMicrophone || defaultDevice?.name || "System Default";

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <nav className="w-56 border-r border-border/40 bg-card/50 backdrop-blur-sm flex flex-col">
        <div className="p-5 border-b border-border/40">
          <h1 className="text-xl font-semibold text-foreground tracking-tight">Winsper</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Voice to text</p>
        </div>
        <div className="p-3 flex-1 space-y-1">
          <Button
            variant={activeTab === "model" ? "secondary" : "ghost"}
            className="w-full justify-start gap-3 h-10"
            onClick={() => setActiveTab("model")}
          >
            <Layers className="h-4 w-4" />
            Model
            {activeModel && (
              <Circle className="h-2 w-2 ml-auto fill-emerald-500 text-emerald-500" />
            )}
            {!activeModel && (
              <Circle className="h-2 w-2 ml-auto fill-amber-500 text-amber-500" />
            )}
          </Button>
          <Button
            variant={activeTab === "settings" ? "secondary" : "ghost"}
            className="w-full justify-start gap-3 h-10"
            onClick={() => setActiveTab("settings")}
          >
            <Settings className="h-4 w-4" />
            Settings
          </Button>
        </div>
        <div className="p-3 border-t border-border/40">
          <p className="text-[10px] text-muted-foreground/60 text-center">
            Press <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">Right Ctrl</kbd> to record
          </p>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        <ScrollArea className="h-full group">
          <div className="p-8 max-w-2xl">
            {/* Model Tab */}
            {activeTab === "model" && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-semibold mb-1 text-foreground tracking-tight">Whisper Models</h2>
                  <p className="text-sm text-muted-foreground">Download and select a model for transcription.</p>
                </div>

                {/* Status */}
                <Card className="border-border/40 bg-card/50">
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className={`h-2 w-2 rounded-full ${activeModel ? "bg-emerald-500" : "bg-amber-500"}`} />
                    <span className="text-sm text-foreground">
                      {activeModel
                        ? `Active: ${activeModel.name}`
                        : "No model loaded - select one below"}
                    </span>
                  </CardContent>
                </Card>

                {/* Model List */}
                <div className="space-y-2">
                  {models.map((model) => (
                    <Card 
                      key={model.id} 
                      className={`border-border/40 bg-card/50 transition-all duration-200 ${
                        model.active ? "ring-1 ring-emerald-500/50 bg-emerald-500/5" : "hover:bg-accent/50"
                      }`}
                    >
                      <CardContent className="flex items-center justify-between p-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">{model.name}</span>
                            {model.active && (
                              <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-500 border-0">
                                Active
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-muted-foreground font-mono truncate">{model.filename}</span>
                            <span className="text-xs text-muted-foreground">•</span>
                            <span className="text-xs text-muted-foreground">{model.size}</span>
                          </div>
                          {downloadingModel === model.id && (
                            <div className="mt-3">
                              <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
                                <div 
                                  className="h-full bg-primary transition-all duration-300 ease-out"
                                  style={{ width: `${downloadProgress}%` }}
                                />
                              </div>
                              <span className="text-[10px] text-muted-foreground mt-1.5 block">
                                Downloading... {downloadProgress}%
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="ml-4 shrink-0">
                          {!model.downloaded ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs border-border/40"
                              onClick={() => handleDownload(model.id)}
                              disabled={downloadingModel !== null}
                            >
                              {downloadingModel === model.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <>
                                  <Download className="h-3.5 w-3.5 mr-1.5" />
                                  Download
                                </>
                              )}
                            </Button>
                          ) : model.active ? (
                            <Button size="sm" variant="secondary" className="h-8 text-xs" disabled>
                              <Check className="h-3.5 w-3.5 mr-1.5" />
                              Selected
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              className="h-8 text-xs"
                              onClick={() => handleLoad(model.id)}
                              disabled={loadingModel !== null}
                            >
                              {loadingModel === model.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                "Select"
                              )}
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                <p className="text-[11px] text-muted-foreground/60">
                  Models are downloaded from HuggingFace. Larger models are more accurate but slower.
                </p>
              </div>
            )}

            {/* Settings Tab */}
            {activeTab === "settings" && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-semibold mb-1 text-foreground tracking-tight">Settings</h2>
                  <p className="text-sm text-muted-foreground">Configure application preferences.</p>
                </div>

                {/* Microphone Selection */}
                <Card className="border-border/40 bg-card/50">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Mic className="h-4 w-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">Microphone</p>
                        <p className="text-xs text-muted-foreground mb-3">Select which microphone to use for recording</p>
                        <Select
                          value={selectedMicrophone || "default"}
                          onValueChange={handleMicrophoneChange}
                        >
                          <SelectTrigger className="w-full h-9 text-xs border-border/40 bg-background/50">
                            <SelectValue placeholder="Select microphone">
                              <span className="truncate">{currentMicName}</span>
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="default" className="text-xs">
                              <div className="flex items-center gap-2">
                                <span>System Default</span>
                                {defaultDevice && (
                                  <span className="text-muted-foreground">({defaultDevice.name})</span>
                                )}
                              </div>
                            </SelectItem>
                            {audioDevices.map((device) => (
                              <SelectItem key={device.id} value={device.id} className="text-xs">
                                <div className="flex items-center gap-2">
                                  <span className="truncate">{device.name}</span>
                                  {device.is_default && (
                                    <Badge variant="secondary" className="text-[9px] px-1 py-0">Default</Badge>
                                  )}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Auto-start */}
                <Card className="border-border/40 bg-card/50">
                  <CardContent className="p-0">
                    <div className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Power className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">Start on system startup</p>
                          <p className="text-xs text-muted-foreground">Automatically launch Winsper when Windows starts</p>
                        </div>
                      </div>
                      <Switch
                        checked={autoStartEnabled}
                        onCheckedChange={handleAutoStartToggle}
                      />
                    </div>
                  </CardContent>
                </Card>

                {/* How to use */}
                <Card className="border-border/40 bg-card/50">
                  <CardContent className="p-4">
                    <p className="text-xs font-medium text-foreground mb-2">How to Use</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Press <kbd className="px-1.5 py-0.5 mx-0.5 rounded bg-muted text-[10px] font-mono">Right Ctrl</kbd> to 
                      start recording. Press again to stop and transcribe. The text will be automatically pasted at your cursor.
                    </p>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}

export default App;
