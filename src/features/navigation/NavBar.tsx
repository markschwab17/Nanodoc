import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function NavBar() {
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  return (
    <nav className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between px-4">
        <Link to="/" className="flex items-center space-x-2">
          <img src="/nanodoc-logo.png" alt="Nanodoc" className="h-6 w-6" />
          <span className="text-xl font-bold">Nanodoc</span>
        </Link>
        
        <div className="flex items-center space-x-4">
          <Link to="/">
            <Button
              variant={isActive("/") ? "default" : "ghost"}
              className={cn(
                "transition-colors",
                isActive("/") && "bg-primary text-primary-foreground"
              )}
            >
              Home
            </Button>
          </Link>
          <Link to="/why">
            <Button
              variant={isActive("/why") ? "default" : "ghost"}
              className={cn(
                "transition-colors",
                isActive("/why") && "bg-primary text-primary-foreground"
              )}
            >
              Why
            </Button>
          </Link>
          <Link to="/editor">
            <Button
              variant={isActive("/editor") ? "default" : "ghost"}
              className={cn(
                "transition-colors",
                isActive("/editor") && "bg-primary text-primary-foreground"
              )}
            >
              Edit PDF now
            </Button>
          </Link>
          <Link to="/faq">
            <Button
              variant={isActive("/faq") ? "default" : "ghost"}
              className={cn(
                "transition-colors",
                isActive("/faq") && "bg-primary text-primary-foreground"
              )}
            >
              FAQ
            </Button>
          </Link>
          <Link to="/compare">
            <Button
              variant={isActive("/compare") ? "default" : "ghost"}
              className={cn(
                "transition-colors",
                isActive("/compare") && "bg-primary text-primary-foreground"
              )}
            >
              Compare
            </Button>
          </Link>
        </div>
      </div>
    </nav>
  );
}

