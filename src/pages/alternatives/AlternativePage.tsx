import { Link, useLocation } from "react-router-dom";
import { NavBar } from "@/features/navigation/NavBar";
import { Button } from "@/components/ui/button";
import { MarketingFooter } from "@/shared/components/MarketingFooter";
import { usePageMeta } from "@/shared/hooks/usePageMeta";
import { FileText, CheckCircle, ArrowRight } from "lucide-react";
import { getAlternative } from "./alternatives";
import { getTask } from "@/pages/tasks/tasks";

// Renders every /<competitor>-alternative page; slug comes from the URL, same
// pattern as TaskPage. The two-column "when to use which" section is the core
// of the page: these pages only work because they concede the competitor's
// strengths plainly.
function AlternativePage() {
  const location = useLocation();
  const slug = location.pathname.replace(/^\/+|\/+$/g, "");
  const alt = getAlternative(slug);

  usePageMeta(alt?.title ?? "Nanodoc", alt?.description);

  if (!alt) {
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

  const related = alt.related
    .map((s) => getTask(s))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  return (
    <div className="min-h-screen bg-background">
      <NavBar />

      <section className="container mx-auto px-4 py-16 md:py-24">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl md:text-5xl font-bold mb-6">{alt.h1}</h1>
          <p className="text-lg md:text-xl text-muted-foreground mb-8">
            {alt.answer}
          </p>
          <Link to="/editor">
            <Button size="lg" className="text-lg px-8 py-6 h-auto">
              <FileText className="mr-2 h-5 w-5" />
              Try Nanodoc free
            </Button>
          </Link>
          <p className="text-sm text-muted-foreground mt-4">
            No sign-up required • No watermark • Files never leave your device
          </p>
        </div>
      </section>

      {/* The honest split */}
      <section className="container mx-auto px-4 py-12 bg-muted/50">
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="bg-card border rounded-lg p-8">
            <h2 className="text-2xl font-bold mb-6">Use Nanodoc for</h2>
            <ul className="space-y-3">
              {alt.nanodocFor.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-card border rounded-lg p-8">
            <h2 className="text-2xl font-bold mb-6">
              Keep {alt.competitor} for
            </h2>
            <ul className="space-y-3">
              {alt.competitorFor.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <ArrowRight className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-center text-sm text-muted-foreground mt-8 max-w-2xl mx-auto">
          Both columns are honest. If the right column is your daily work,
          {" "}{alt.competitor} is worth its price and we would rather say so than
          have you find out after switching.
        </p>
      </section>

      {/* FAQ */}
      <section className="container mx-auto px-4 py-16">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold mb-8 text-center">
            Common questions
          </h2>
          <div className="space-y-8">
            {alt.faqs.map((faq, i) => (
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

      {/* CTA + related */}
      <section className="container mx-auto px-4 py-12 bg-muted/50">
        <div className="max-w-3xl mx-auto text-center">
          <Link to="/editor">
            <Button size="lg" className="text-lg px-8 py-5 h-auto mb-10">
              <FileText className="mr-2 h-5 w-5" />
              Try Nanodoc free
            </Button>
          </Link>
          <h2 className="text-xl font-semibold mb-4">See what Nanodoc does</h2>
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
              Full comparison
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

export default AlternativePage;
