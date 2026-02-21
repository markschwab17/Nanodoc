import { useEffect, useState } from "react";
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
        <p className="text-lg font-medium text-foreground">{message}</p>
        {/* Bar with moving shimmer – animation in global CSS so it always runs */}
        <div className="w-64 h-1.5 bg-secondary rounded-full overflow-hidden">
          <div
            className="loading-bar-shimmer h-full w-1/2 rounded-full bg-primary"
            style={{ willChange: "transform" }}
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}

