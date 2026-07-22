import { Link, useLocation } from "react-router-dom";
import { NavBar } from "@/features/navigation/NavBar";
import { Button } from "@/components/ui/button";
import { MarketingFooter } from "@/shared/components/MarketingFooter";
import { usePageMeta } from "@/shared/hooks/usePageMeta";
import { FileText, CheckCircle } from "lucide-react";
import { getTask, TASKS } from "./tasks";

// One component renders every task landing page; the slug comes from the URL
// so the router and the prerender entry can both map /<slug> straight here.
// FAQ answers are plain visible markup (not an accordion) on purpose: answer
// engines only ingest what is in the HTML.
function TaskPage() {
  const location = useLocation();
  const slug = location.pathname.replace(/^\/+|\/+$/g, "");
  const task = getTask(slug);

  usePageMeta(task?.title ?? "Nanodoc", task?.description);

  if (!task) {
    return (
      <div className="min-h-screen bg-background">
        <NavBar />
        <section className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-3xl font-bold mb-4">Page not found</h1>
          <Link to="/" className="text-primary hover:underline">
            Back to the home page
          </Link>
        </section>
      </div>
    );
  }

  const related = task.related
    .map((s) => TASKS.find((t) => t.slug === s))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  return (
    <div className="min-h-screen bg-background">
      <NavBar />

      {/* Hero: H1 + the direct answer, then the CTA */}
      <section className="container mx-auto px-4 py-16 md:py-24">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl md:text-5xl font-bold mb-6">{task.h1}</h1>
          <p className="text-lg md:text-xl text-muted-foreground mb-8">
            {task.answer}
          </p>
          <Link to={task.ctaPath}>
            <Button size="lg" className="text-lg px-8 py-6 h-auto">
              <FileText className="mr-2 h-5 w-5" />
              {task.ctaLabel}
            </Button>
          </Link>
          <p className="text-sm text-muted-foreground mt-4">
            No sign-up required • No watermark • Files never leave your device
          </p>
        </div>
      </section>

      {/* How-to steps */}
      <section className="container mx-auto px-4 py-12 bg-muted/50">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold mb-8 text-center">How it works</h2>
          <ol className="space-y-4">
            {task.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-4">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-semibold shrink-0">
                  {i + 1}
                </span>
                <p className="text-lg text-muted-foreground pt-1">{step}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* FAQ, always expanded */}
      <section className="container mx-auto px-4 py-16">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold mb-8 text-center">
            Common questions
          </h2>
          <div className="space-y-8">
            {task.faqs.map((faq, i) => (
              <div key={i}>
                <h3 className="text-xl font-semibold mb-2 flex items-start gap-2">
                  <CheckCircle className="h-5 w-5 text-primary mt-1 shrink-0" />
                  {faq.question}
                </h3>
                <p className="text-muted-foreground ml-7">{faq.answer}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Second CTA + related tools */}
      <section className="container mx-auto px-4 py-12 bg-muted/50">
        <div className="max-w-3xl mx-auto text-center">
          <Link to={task.ctaPath}>
            <Button size="lg" className="text-lg px-8 py-5 h-auto mb-10">
              <FileText className="mr-2 h-5 w-5" />
              {task.ctaLabel}
            </Button>
          </Link>
          <h2 className="text-xl font-semibold mb-4">Related tools</h2>
          <div className="flex flex-wrap gap-3 justify-center">
            {related.map((r) => (
              <Link
                key={r.slug}
                to={`/${r.slug}`}
                className="px-4 py-2 rounded-full border bg-card text-sm hover:border-primary transition-colors"
              >
                {r.h1}
              </Link>
            ))}
            <Link
              to="/compare"
              className="px-4 py-2 rounded-full border bg-card text-sm hover:border-primary transition-colors"
            >
              Compare PDF editors
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

export default TaskPage;
