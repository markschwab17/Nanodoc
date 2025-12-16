import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Component that redirects desktop users to the editor
 * Desktop is defined as screen width >= 768px
 */
export function DesktopRedirect({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);

  useEffect(() => {
    const checkScreenSize = () => {
      // Check if screen width is desktop size (>= 768px)
      const desktop = window.innerWidth >= 768;
      setIsDesktop(desktop);
      
      if (desktop) {
        navigate("/editor", { replace: true });
      }
    };

    // Check on mount
    checkScreenSize();

    // Also listen for resize events in case window is resized
    window.addEventListener("resize", checkScreenSize);

    return () => {
      window.removeEventListener("resize", checkScreenSize);
    };
  }, [navigate]);

  // Don't render anything until we've checked screen size
  // If desktop, redirect will happen, so return null
  // If mobile, render children (Home component)
  if (isDesktop === null || isDesktop) {
    return null;
  }

  return <>{children}</>;
}

