import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Layers, Keyboard, FileText, Circle, Download, Check, Loader2 } from "lucide-react";
import "@/index.css";

type Tab = "model" | "hotkey" | "activity";

interface ModelInfo {
  id: string;
  name: string;
  filename: string;
  size: string;
  downloaded: boolean;
  active: boolean;
}

interface ActivityItem {
  id: number;
  type: "transcription" | "error" | "info";
  message: string;
  timestamp: Date;
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("model");

  // Model state
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModel, setLoadingModel] = useState<string | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);

  // Hotkey state
  const [lastHotkey, setLastHotkey] = useState<string>("None");
  const [isRecording, setIsRecording] = useState(false);

  // Activity log
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [activityId, setActivityId] = useState(0);

  // Add activity helper
  const addActivity = (type: ActivityItem["type"], message: string) => {
    setActivityId((prev) => {
      const newId = prev + 1;
      setActivities((acts) => [
        { id: newId, type, message, timestamp: new Date() },
        ...acts.slice(0, 49),
      ]);
      return newId;
    });
  };

  // Load models list
  const refreshModels = async () => {
    try {
      const modelList = await invoke<ModelInfo[]>("list_models");
      setModels(modelList);
    } catch (e) {
      console.error("Failed to list models:", e);
    }
  };

  // Load initial state
  useEffect(() => {
    refreshModels();
  }, []);

  // Listen for Tauri events
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<string>("hotkey_event", (event) => {
      setLastHotkey(event.payload);
    }).then((un) => unlisteners.push(un));

    listen("recording_started", () => {
      setIsRecording(true);
      addActivity("info", "Recording started...");
    }).then((un) => unlisteners.push(un));

    listen("recording_stopped", () => {
      setIsRecording(false);
      addActivity("info", "Recording stopped, processing...");
    }).then((un) => unlisteners.push(un));

    listen<string>("transcription_done", (event) => {
      addActivity("transcription", event.payload);
    }).then((un) => unlisteners.push(un));

    listen<string>("transcription_error", (event) => {
      addActivity("error", event.payload);
    }).then((un) => unlisteners.push(un));

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
      addActivity("info", `Downloaded model: ${modelId}`);
    } catch (e) {
      addActivity("error", `Failed to download: ${e}`);
      setDownloadingModel(null);
    }
  };

  const handleLoad = async (modelId: string) => {
    try {
      setLoadingModel(modelId);
      await invoke("load_model", { modelId });
      await refreshModels();
      addActivity("info", `Loaded model: ${modelId}`);
    } catch (e) {
      addActivity("error", `Failed to load model: ${e}`);
    } finally {
      setLoadingModel(null);
    }
  };

  const activeModel = models.find((m) => m.active);

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <nav className="w-56 border-r bg-card flex flex-col">
        <div className="p-5 border-b">
          <h1 className="text-xl font-semibold text-foreground">Winsper</h1>
        </div>
        <div className="p-3 flex-1 space-y-1">
          <Button
            variant={activeTab === "model" ? "default" : "ghost"}
            className="w-full justify-start gap-3"
            onClick={() => setActiveTab("model")}
          >
            <Layers className="h-4 w-4" />
            Model
            {activeModel && (
              <Circle className="h-2 w-2 ml-auto fill-green-500 text-green-500" />
            )}
            {!activeModel && (
              <Circle className="h-2 w-2 ml-auto text-yellow-500" />
            )}
          </Button>
          <Button
            variant={activeTab === "hotkey" ? "default" : "ghost"}
            className="w-full justify-start gap-3"
            onClick={() => setActiveTab("hotkey")}
          >
            <Keyboard className="h-4 w-4" />
            Hotkey
            {isRecording && (
              <Circle className="h-2 w-2 ml-auto fill-red-500 text-red-500 animate-pulse" />
            )}
          </Button>
          <Button
            variant={activeTab === "activity" ? "default" : "ghost"}
            className="w-full justify-start gap-3"
            onClick={() => setActiveTab("activity")}
          >
            <FileText className="h-4 w-4" />
            Activity
            {activities.length > 0 && (
              <Badge variant="secondary" className="ml-auto text-xs">
                {activities.length}
              </Badge>
            )}
          </Button>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-auto">
        <div className="max-w-xl">
          {/* Model Tab */}
          {activeTab === "model" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-semibold mb-2 text-foreground">Whisper Models</h2>
                <p className="text-muted-foreground">Download and select a model for transcription.</p>
              </div>

              {/* Status */}
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <Circle
                    className={`h-3 w-3 ${
                      activeModel
                        ? "fill-green-500 text-green-500"
                        : "text-muted-foreground"
                    }`}
                  />
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
                  <Card key={model.id} className={model.active ? "ring-2 ring-green-500" : ""}>
                    <CardContent className="flex items-center justify-between p-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{model.name}</span>
                          {model.active && (
                            <Badge variant="default" className="text-xs bg-green-600">
                              Active
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          <code className="text-xs text-muted-foreground">{model.filename}</code>
                          <span className="text-xs text-muted-foreground">•</span>
                          <span className="text-xs text-muted-foreground">{model.size}</span>
                        </div>
                        {downloadingModel === model.id && (
                          <div className="mt-2">
                            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-blue-500 transition-all duration-300"
                                style={{ width: `${downloadProgress}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground mt-1">
                              Downloading... {downloadProgress}%
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="ml-4">
                        {!model.downloaded ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDownload(model.id)}
                            disabled={downloadingModel !== null}
                          >
                            {downloadingModel === model.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <>
                                <Download className="h-4 w-4 mr-1" />
                                Download
                              </>
                            )}
                          </Button>
                        ) : model.active ? (
                          <Button size="sm" variant="secondary" disabled>
                            <Check className="h-4 w-4 mr-1" />
                            Selected
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => handleLoad(model.id)}
                            disabled={loadingModel !== null}
                          >
                            {loadingModel === model.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
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

              <p className="text-xs text-muted-foreground">
                Models are downloaded from HuggingFace. Larger models are more accurate but slower.
              </p>
            </div>
          )}

          {/* Hotkey Tab */}
          {activeTab === "hotkey" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-semibold mb-2 text-foreground">Hotkey Test</h2>
                <p className="text-muted-foreground">Test that your hotkeys are being detected properly.</p>
              </div>

              <Card>
                <CardContent className="p-0">
                  <div className="flex justify-between items-center p-4">
                    <span className="text-muted-foreground">Last Detected Key</span>
                    <Badge variant={lastHotkey !== "None" ? "default" : "secondary"}>
                      {lastHotkey}
                    </Badge>
                  </div>
                  <Separator />
                  <div className="flex justify-between items-center p-4">
                    <span className="text-muted-foreground">Recording Status</span>
                    <Badge variant={isRecording ? "destructive" : "secondary"} className="gap-2">
                      <Circle className={`h-2 w-2 ${isRecording ? "fill-current animate-pulse" : ""}`} />
                      {isRecording ? "Recording..." : "Not Recording"}
                    </Badge>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground space-y-2">
                  <p className="font-medium text-foreground">How to Use</p>
                  <p>
                    Press <kbd className="px-2 py-1 rounded bg-secondary text-secondary-foreground text-xs font-medium">Right Ctrl</kbd> to toggle recording on/off.
                  </p>
                  <p>The transcribed text will be automatically pasted at your cursor position.</p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Activity Tab */}
          {activeTab === "activity" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-semibold mb-2 text-foreground">Activity Log</h2>
                <p className="text-muted-foreground">Recent transcriptions and events.</p>
              </div>

              <Card>
                <ScrollArea className="h-[400px]">
                  {activities.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-[300px] text-center p-6">
                      <FileText className="h-12 w-12 text-muted-foreground mb-4" />
                      <p className="text-muted-foreground mb-2">No activity yet</p>
                      <span className="text-sm text-muted-foreground">
                        Press <kbd className="px-2 py-1 rounded bg-secondary text-secondary-foreground text-xs font-medium">Right Ctrl</kbd> to start recording
                      </span>
                    </div>
                  ) : (
                    <div className="p-2 space-y-1">
                      {activities.map((item) => (
                        <div
                          key={item.id}
                          className={`flex gap-3 p-3 rounded-md text-sm ${
                            item.type === "transcription"
                              ? "bg-green-500/10 border-l-2 border-green-500"
                              : item.type === "error"
                              ? "bg-red-500/10 border-l-2 border-red-500"
                              : "bg-muted/50 border-l-2 border-muted"
                          }`}
                        >
                          <span className="text-xs text-muted-foreground font-mono shrink-0">
                            {item.timestamp.toLocaleTimeString()}
                          </span>
                          <span className={item.type === "error" ? "text-red-400" : "text-foreground"}>
                            {item.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </Card>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
