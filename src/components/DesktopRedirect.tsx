import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Component that redirects Tauri desktop app users to the editor.
 * Web users (regardless of screen size) will see the Home page.
 */
export function DesktopRedirect({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [isTauri, setIsTauri] = useState<boolean | null>(null);

  useEffect(() => {
    // Check if running in Tauri desktop app
    const isRunningInTauri = typeof window !== "undefined" && "__TAURI__" in window;
    setIsTauri(isRunningInTauri);
    
    if (isRunningInTauri) {
      navigate("/editor", { replace: true });
    }
  }, [navigate]);

  // Don't render anything until we've checked environment
  // If Tauri, redirect will happen, so return null
  // If web, render children (Home component)
  if (isTauri === null || isTauri) {
    return null;
  }

  return <>{children}</>;
}

