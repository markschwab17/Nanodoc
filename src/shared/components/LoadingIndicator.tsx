import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface LoadingIndicatorProps {
  isLoading: boolean;
  message?: string;
  className?: string;
}

export function LoadingIndicator({
  isLoading,
  message = "Loading PDF...",
  className,
}: LoadingIndicatorProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isLoading) {
      setShow(true);
    } else {
      // Delay hiding to prevent flicker
      const timer = setTimeout(() => setShow(false), 100);
      return () => clearTimeout(timer);
    }
  }, [isLoading]);

  if (!show) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm",
        className
      )}
    >
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <div className="flex flex-col items-center gap-2">
          <p className="text-lg font-medium text-foreground">{message}</p>
          <div className="w-64 h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full animate-pulse" style={{ width: "100%" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

