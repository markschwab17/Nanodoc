import { Link } from "react-router-dom";
import { NavBar } from "@/features/navigation/NavBar";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, FileText, Ruler, Calculator, ClipboardList } from "lucide-react";

const VG_BASE = "https://vertigraph.com";
const VG_LOGO = `${VG_BASE}/brand/vertigraph-logo.png`;
const BIDSCREEN_ICON = `${VG_BASE}/products/bidscreen-xl/logo-icon.png`;
const SITEWORX_ICON = `${VG_BASE}/products/siteworx-os/logo-icon.png`;

const CivilTakeoffWordmark = () => (
  <span className="text-2xl font-bold tracking-tight whitespace-nowrap">
    <span className="text-foreground">civiltakeoff</span>
    <span style={{ color: "#5070ff" }}>.ai</span>
  </span>
);

type SubProduct = {
  name: string;
  icon: string;
  href: string;
  description: string;
};

function PartnerCard({
  eyebrow,
  badge,
  logo,
  logoAlt,
  logoBg = "bg-card",
  title,
  description,
  bullets,
  subProducts,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
}: {
  eyebrow: string;
  badge?: string;
  logo: string | React.ReactNode;
  logoAlt?: string;
  logoBg?: string;
  title: string;
  description: string;
  bullets?: string[];
  subProducts?: SubProduct[];
  primaryHref: string;
  primaryLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <div className="rounded-2xl border bg-card p-8 shadow-sm flex flex-col">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className={`flex items-center justify-center rounded-xl border ${logoBg} h-20 px-4 min-w-[140px]`}>
          {typeof logo === "string" ? (
            <img
              src={logo}
              alt={logoAlt ?? ""}
              className="max-h-12 w-auto object-contain"
            />
          ) : (
            logo
          )}
        </div>
        {badge && (
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/60 text-muted-foreground text-xs font-medium px-3 py-1.5 whitespace-nowrap">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
            {badge}
          </span>
        )}
      </div>

      <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">
        {eyebrow}
      </p>
      <h2 className="text-2xl md:text-3xl font-semibold mb-4">{title}</h2>
      <p className="text-muted-foreground leading-relaxed mb-6">{description}</p>

      {bullets && bullets.length > 0 && (
        <ul className="flex flex-col gap-2.5 text-sm text-muted-foreground mb-6">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2.5">
              <span className="mt-1.5 inline-block w-1.5 h-1.5 rounded-full bg-primary/70 shrink-0" />
              <span className="leading-relaxed">{b}</span>
            </li>
          ))}
        </ul>
      )}

      {subProducts && subProducts.length > 0 && (
        <div className="border-t pt-6 mb-6 flex flex-col gap-5">
          {subProducts.map((sp) => (
            <a
              key={sp.name}
              href={sp.href}
              target="_blank"
              rel="noopener"
              className="group flex items-start gap-4 -mx-2 px-2 py-2 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center justify-center rounded-lg border bg-card h-12 w-12 shrink-0">
                <img
                  src={sp.icon}
                  alt={`${sp.name} logo`}
                  className="max-h-8 max-w-8 object-contain"
                />
              </div>
              <div className="min-w-0">
                <div className="font-semibold flex items-center gap-1.5">
                  {sp.name}
                  <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-primary group-hover:-translate-y-0.5 group-hover:translate-x-0.5 transition-transform" />
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed mt-1">
                  {sp.description}
                </p>
              </div>
            </a>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-x-6 gap-y-3 pt-2">
        <a
          href={primaryHref}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 text-primary font-semibold hover:underline"
        >
          {primaryLabel}
          <ArrowUpRight className="h-4 w-4" />
        </a>
        {secondaryHref && secondaryLabel && (
          <a
            href={secondaryHref}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1.5 text-muted-foreground font-medium hover:text-foreground"
          >
            {secondaryLabel}
            <ArrowUpRight className="h-4 w-4" />
          </a>
        )}
      </div>
    </div>
  );
}

function Partners() {
  return (
    <div className="h-screen overflow-y-auto bg-background">
      <NavBar />

      {/* Hero */}
      <section className="container mx-auto px-4 py-20 md:py-28">
        <div className="max-w-4xl mx-auto text-center">
          <p className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-muted-foreground mb-6">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
            Nanodoc · Partners
          </p>
          <h1 className="text-5xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
            Software we love, from people we trust.
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            A lot of Nanodoc users are in <span className="text-foreground font-medium">construction</span> —
            estimators, contractors, and project managers who live inside PDF
            plan sets. If that's you, the tools below pick up where Nanodoc
            stops. If it's not you, you can safely skip the rest of this page.
          </p>
        </div>
      </section>

      {/* Primer: What is takeoff & estimating? */}
      <section className="container mx-auto px-4 pb-8">
        <div className="max-w-5xl mx-auto rounded-2xl border bg-muted/40 p-8 md:p-10">
          <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-3">
            A quick primer
          </p>
          <h2 className="text-2xl md:text-3xl font-bold mb-6">
            What is construction takeoff and estimating?
          </h2>
          <p className="text-muted-foreground leading-relaxed mb-8 max-w-3xl">
            Before any building gets built, someone has to figure out how much
            of everything it'll need — concrete, pipe, asphalt, labor hours,
            equipment time. That whole process happens on PDFs of architectural
            and civil drawings. Here's the rough flow, and where each tool
            below fits in.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="bg-card border rounded-xl p-5">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                <Ruler className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold mb-1.5">1. Takeoff</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Measuring quantities directly off the drawings — lengths of
                pipe, square footage of paving, volume of dirt to move.
              </p>
            </div>
            <div className="bg-card border rounded-xl p-5">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                <Calculator className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold mb-1.5">2. Estimating</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Turning those quantities into a price. Material costs, labor
                rates, equipment, overhead, and margin all roll into a bid.
              </p>
            </div>
            <div className="bg-card border rounded-xl p-5">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                <ClipboardList className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold mb-1.5">3. Bid management</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Tracking the dozens of bids in flight, the emails, the
                subcontractor quotes, and the deadlines so nothing slips.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Partners Grid */}
      <section className="container mx-auto px-4 pb-12">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* CivilTakeoff.ai */}
          <PartnerCard
            eyebrow="Cloud takeoff + bid management"
            logo={<CivilTakeoffWordmark />}
            logoBg="bg-white"
            title="CivilTakeoff.ai"
            description="A modern, browser-based replacement for the desktop takeoff tools estimators have used for decades. Open a PDF plan set, measure quantities with your team in real time, and skip the licensing dance — anyone with a login can work from any computer. The included Project War Room then keeps every email, RFQ, and bid in one place so the next person who joins the team inherits real institutional knowledge instead of a blank inbox."
            bullets={[
              "Upload a PDF plan set and start measuring in minutes",
              "Works in any browser — no installs, no license-key transfers",
              "Real-time collaboration so a team can split a big takeoff",
              "AI assists with auto-trace, auto-scale, and class suggestions",
              "Project War Room tracks bids, emails, RFQs, and deadlines",
              "Free to start — no credit card required",
            ]}
            primaryHref="https://civiltakeoff.ai"
            primaryLabel="Visit CivilTakeoff.ai"
          />

          {/* Vertigraph */}
          <PartnerCard
            eyebrow="Desktop takeoff + Excel estimating"
            badge="Coming soon"
            logo={VG_LOGO}
            logoAlt="Vertigraph logo"
            logoBg="bg-white"
            title="Vertigraph"
            description="Vertigraph builds desktop tools for estimators who already do their best work inside Microsoft Excel. If your team's pricing logic, formulas, and templates already live in spreadsheets, these tools meet you there — measure on the drawing, drop the quantities straight into Excel, and let your existing workbook do the math. SiteWorx/OS extends that same idea to earthwork, where the answer isn't a length or area but a volume of dirt."
            subProducts={[
              {
                name: "BidScreen XL",
                icon: BIDSCREEN_ICON,
                href: "https://vertigraph.com/products/bidscreen-xl",
                description:
                  "Takeoff that lives inside Excel itself. Measure from PDFs, DWGs, DXFs, and TIFs and let your spreadsheet formulas drive the price.",
              },
              {
                name: "SiteWorx/OS",
                icon: SITEWORX_ICON,
                href: "https://vertigraph.com/products/siteworx-os",
                description:
                  "Earthwork specialist. Builds 3D models of existing and proposed ground, calculates cut and fill volumes, and exports machine-control files for excavator GPS systems.",
              },
            ]}
            primaryHref="https://vertigraph.com"
            primaryLabel="Visit Vertigraph"
          />
        </div>
      </section>

      {/* What earns a spot */}
      <section className="container mx-auto px-4 py-16">
        <div className="max-w-5xl mx-auto">
          <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground text-center mb-3">
            What earns a spot here
          </p>
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-10">
            We use it ourselves, or we don't list it.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 rounded-lg border bg-card">
              <h3 className="font-semibold mb-2">Real overlap</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Tools our users actually pair with Nanodoc — not random
                affiliate deals.
              </p>
            </div>
            <div className="p-6 rounded-lg border bg-card">
              <h3 className="font-semibold mb-2">Construction-first</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Built for estimators, takeoff, and the workflows around bid
                documents.
              </p>
            </div>
            <div className="p-6 rounded-lg border bg-card">
              <h3 className="font-semibold mb-2">Useful on bid week</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Software that holds up under real deadlines — not roadmap-deck
                vaporware.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="container mx-auto px-4 py-20 bg-muted/50">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Building something estimators would actually use?
          </h2>
          <p className="text-lg text-muted-foreground mb-8 leading-relaxed">
            We're open to partnering with construction software teams whose
            tools complement Nanodoc and the rest of the lineup. Drop us a
            line.
          </p>
          <Link to="/faq">
            <Button size="lg" className="text-base px-6 py-5 h-auto">
              <FileText className="mr-2 h-5 w-5" />
              Get in touch
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t bg-muted/50">
        <div className="container mx-auto px-4 py-8">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="flex items-center space-x-2 mb-4 md:mb-0">
              <img src="/nanodoc-logo.png" alt="Nanodoc" className="h-5 w-5" />
              <span className="font-semibold">Nanodoc</span>
            </div>
            <div className="flex flex-wrap gap-4 justify-center">
              <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
                Home
              </Link>
              <Link to="/why" className="text-sm text-muted-foreground hover:text-foreground">
                Why
              </Link>
              <Link to="/editor" className="text-sm text-muted-foreground hover:text-foreground">
                Editor
              </Link>
              <Link to="/faq" className="text-sm text-muted-foreground hover:text-foreground">
                FAQ
              </Link>
              <Link to="/compare" className="text-sm text-muted-foreground hover:text-foreground">
                Compare
              </Link>
              <Link to="/partners" className="text-sm text-muted-foreground hover:text-foreground">
                Partners
              </Link>
            </div>
          </div>
          <div className="mt-4 text-center text-sm text-muted-foreground space-y-2">
            <div>
              © {new Date().getFullYear()} Nanodoc. 100% Free. No Paywalls.
            </div>
            <div className="flex flex-wrap gap-4 justify-center">
              <Link to="/privacy" className="hover:text-foreground">
                Privacy Statement
              </Link>
              <span className="text-muted-foreground">•</span>
              <Link to="/terms" className="hover:text-foreground">
                Terms and Conditions
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default Partners;
