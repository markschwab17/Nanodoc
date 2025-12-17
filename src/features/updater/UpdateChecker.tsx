import { useEffect, useState, useCallback } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, RefreshCw, X, CheckCircle2 } from "lucide-react";

interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export function UpdateChecker() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<UpdateProgress | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);

  // Check for updates on component mount
  const checkForUpdates = useCallback(async () => {
    // Only run in Tauri environment
    if (typeof window === "undefined" || !(window as any).__TAURI__) {
      return;
    }

    setIsChecking(true);
    setError(null);

    try {
      const updateResult = await check();
      if (updateResult) {
        setUpdate(updateResult);
        setShowDialog(true);
      }
    } catch (err) {
      console.error("Error checking for updates:", err);
      // Don't show error to user for automatic checks - just log it
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    // Check for updates after a short delay to let the app fully initialize
    const timer = setTimeout(() => {
      checkForUpdates();
    }, 3000);

    return () => clearTimeout(timer);
  }, [checkForUpdates]);

  const handleDownloadAndInstall = async () => {
    if (!update) return;

    setIsDownloading(true);
    setError(null);

    try {
      await update.downloadAndInstall((progress) => {
        if (progress.event === "Started") {
          setDownloadProgress({
            downloaded: 0,
            total: progress.data.contentLength ?? null,
          });
        } else if (progress.event === "Progress") {
          setDownloadProgress((prev) => ({
            downloaded: (prev?.downloaded ?? 0) + progress.data.chunkLength,
            total: prev?.total ?? null,
          }));
        } else if (progress.event === "Finished") {
          setIsInstalled(true);
        }
      });

      setIsInstalled(true);
    } catch (err) {
      console.error("Error downloading update:", err);
      setError(
        err instanceof Error ? err.message : "Failed to download update"
      );
    } finally {
      setIsDownloading(false);
    }
  };

  const handleRelaunch = async () => {
    try {
      await relaunch();
    } catch (err) {
      console.error("Error relaunching app:", err);
      setError(
        err instanceof Error ? err.message : "Failed to restart application"
      );
    }
  };

  const handleClose = () => {
    if (!isDownloading) {
      setShowDialog(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const getProgressPercentage = (): number => {
    if (!downloadProgress || !downloadProgress.total) return 0;
    return Math.round((downloadProgress.downloaded / downloadProgress.total) * 100);
  };

  if (!update || !showDialog) {
    return null;
  }

  return (
    <Dialog open={showDialog} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isInstalled ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                Update Ready
              </>
            ) : (
              <>
                <Download className="h-5 w-5 text-primary" />
                Update Available
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {isInstalled ? (
              "The update has been installed. Restart the app to apply changes."
            ) : (
              <>
                A new version of Nanodoc is available!
                <br />
                <span className="font-medium text-foreground">
                  Version {update.version}
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Release Notes */}
        {update.body && !isInstalled && (
          <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/50 p-3 text-sm">
            <h4 className="mb-2 font-medium">What's New:</h4>
            <div className="whitespace-pre-wrap text-muted-foreground">
              {update.body}
            </div>
          </div>
        )}

        {/* Download Progress */}
        {isDownloading && downloadProgress && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Downloading...</span>
              <span>
                {formatBytes(downloadProgress.downloaded)}
                {downloadProgress.total && ` / ${formatBytes(downloadProgress.total)}`}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${getProgressPercentage()}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {getProgressPercentage()}% complete
            </p>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          {isInstalled ? (
            <Button onClick={handleRelaunch} className="w-full sm:w-auto">
              <RefreshCw className="mr-2 h-4 w-4" />
              Restart Now
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={handleClose}
                disabled={isDownloading}
                className="w-full sm:w-auto"
              >
                <X className="mr-2 h-4 w-4" />
                Later
              </Button>
              <Button
                onClick={handleDownloadAndInstall}
                disabled={isDownloading || isChecking}
                className="w-full sm:w-auto"
              >
                {isDownloading ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Downloading...
                  </>
                ) : (
                  <>
                    <Download className="mr-2 h-4 w-4" />
                    Download & Install
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}



