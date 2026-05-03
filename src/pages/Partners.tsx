import { Link } from "react-router-dom";
import { NavBar } from "@/features/navigation/NavBar";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, FileText } from "lucide-react";

const VG_BASE = "https://vertigraph.com";
const CIVIL_ICON = `${VG_BASE}/partners/civiltakeoff-icon.png`;
const VG_LOGO = `${VG_BASE}/brand/vertigraph-logo.png`;
const BIDSCREEN_ICON = `${VG_BASE}/products/bidscreen-xl/logo-icon.png`;
const SITEWORX_ICON = `${VG_BASE}/products/siteworx-os/logo-icon.png`;

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
  logo: string;
  logoAlt: string;
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
          <img
            src={logo}
            alt={logoAlt}
            className="max-h-12 w-auto object-contain"
          />
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
            Partners in <span className="text-primary">construction</span>.
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Nanodoc keeps PDF editing free and out of the way. When the work
            moves beyond a single document — into takeoff, estimating, and bid
            management — these are the tools we point our users to.
          </p>
        </div>
      </section>

      {/* Partners Grid */}
      <section className="container mx-auto px-4 pb-12">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* CivilTakeoff.ai */}
          <PartnerCard
            eyebrow="CivilTakeoff.ai · Cloud Takeoff"
            logo={CIVIL_ICON}
            logoAlt="CivilTakeoff.ai logo"
            title="CivilTakeoff.ai"
            description="Cloud-based quantity takeoff that puts professional-grade measurement in your team's hands. One login from any browser — no license-key transfers, no file-syncing nightmares. Pair it with the Project War Room for AI-assisted RFQs, email tracking, checklists, and dashboards that capture every lesson, email, and bid in one place."
            bullets={[
              "Lightning-fast setup — upload PDFs and start measuring",
              "Auto-trace, multi-point arcs, and company classes to cut repetition",
              "Real-time collaboration with your team from any browser",
              "Project War Room: RFQs, email tracking, signatures, and dashboards",
              "Free to start — no credit card required",
            ]}
            primaryHref="https://civiltakeoff.ai"
            primaryLabel="Visit CivilTakeoff.ai"
            secondaryHref="https://civiltakeoff.ai"
            secondaryLabel="Project War Room"
          />

          {/* Vertigraph */}
          <PartnerCard
            eyebrow="Vertigraph · Desktop Estimating"
            badge="Coming soon"
            logo={VG_LOGO}
            logoAlt="Vertigraph logo"
            logoBg="bg-white"
            title="Vertigraph"
            description="Vertigraph builds purpose-built construction takeoff and estimating software. Hand off CivilTakeoff measurements straight into BidScreen XL for Excel-driven estimating, or into SiteWorx/OS for site excavation volumes and 3D surface modeling."
            subProducts={[
              {
                name: "BidScreen XL",
                icon: BIDSCREEN_ICON,
                href: "https://vertigraph.com/products/bidscreen-xl",
                description:
                  "On-screen takeoff inside Microsoft Excel. Measure from PDFs, DWGs, DXFs, and TIFs and let Excel formulas drive the estimate.",
              },
              {
                name: "SiteWorx/OS",
                icon: SITEWORX_ICON,
                href: "https://vertigraph.com/products/siteworx-os",
                description:
                  "Site excavation takeoff with 3D existing and proposed surface models, cut/fill volumes, and machine-control deliverables for earthwork contractors.",
              },
            ]}
            primaryHref="https://vertigraph.com"
            primaryLabel="Visit Vertigraph"
            secondaryHref="https://vertigraph.com/products"
            secondaryLabel="Request early access"
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
