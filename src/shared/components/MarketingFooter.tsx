import { Link } from "react-router-dom";
import { TASKS } from "@/pages/tasks/tasks";
import { ALTERNATIVES } from "@/pages/alternatives/alternatives";

// Shared footer for all marketing pages. The Tools column links every task
// landing page from every page, which is what lets crawlers discover them.
export function MarketingFooter() {
  return (
    <footer className="border-t bg-muted/50">
      <div className="container mx-auto px-4 py-10">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          <div>
            <div className="flex items-center space-x-2 mb-3">
              <img src="/nanodoc-logo.png" alt="Nanodoc" className="h-5 w-5" />
              <span className="font-semibold">Nanodoc</span>
            </div>
            <p className="text-sm text-muted-foreground max-w-xs">
              A free, open-source PDF editor that runs on your device. No
              sign-up, no watermark, no paywall.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold mb-3">Tools</h3>
            <ul className="space-y-2">
              {TASKS.map((task) => (
                <li key={task.slug}>
                  <Link
                    to={`/${task.slug}`}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    {task.h1}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold mb-3">Alternatives</h3>
            <ul className="space-y-2">
              {ALTERNATIVES.map((alt) => (
                <li key={alt.slug}>
                  <Link
                    to={`/${alt.slug}`}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    {alt.competitor} alternative
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold mb-3">Nanodoc</h3>
            <ul className="space-y-2">
              <li>
                <Link to="/editor" className="text-sm text-muted-foreground hover:text-foreground">
                  Open the editor
                </Link>
              </li>
              <li>
                <Link to="/stitch" className="text-sm text-muted-foreground hover:text-foreground">
                  Stitch tool
                </Link>
              </li>
              <li>
                <Link to="/why" className="text-sm text-muted-foreground hover:text-foreground">
                  Why Nanodoc exists
                </Link>
              </li>
              <li>
                <Link to="/faq" className="text-sm text-muted-foreground hover:text-foreground">
                  FAQ
                </Link>
              </li>
              <li>
                <Link to="/compare" className="text-sm text-muted-foreground hover:text-foreground">
                  Compare PDF editors
                </Link>
              </li>
              <li>
                <Link to="/partners" className="text-sm text-muted-foreground hover:text-foreground">
                  Partners
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t pt-6 text-center text-sm text-muted-foreground space-y-2">
          <div>© {new Date().getFullYear()} Nanodoc. 100% Free. No Paywalls.</div>
          <div className="flex flex-wrap gap-4 justify-center">
            <Link to="/privacy" className="hover:text-foreground">
              Privacy Statement
            </Link>
            <span>•</span>
            <Link to="/terms" className="hover:text-foreground">
              Terms and Conditions
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
