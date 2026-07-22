// Per-route <head> metadata for the prerendered marketing pages.
// scripts/prerender.mjs reads this (via the SSR bundle) to stamp each emitted
// HTML file with its own title, description, canonical, and JSON-LD.
import { FAQS } from "@/pages/faqData";
import { TASKS } from "@/pages/tasks/tasks";
import { ALTERNATIVES } from "@/pages/alternatives/alternatives";

export const SITE_ORIGIN = "https://nanodoc.app";

export interface PrerenderRoute {
  path: string;
  title: string;
  description: string;
  /** Route-specific JSON-LD blocks (homepage keeps the ones in index.html) */
  jsonLd?: object[];
  /**
   * App-shell routes are emitted with an empty #root (no SSR markup) so the
   * SPA fallback never flashes homepage content inside the editor or embeds.
   */
  shell?: boolean;
  /** Excluded from sitemap.xml and marked noindex (embed-only routes) */
  noindex?: boolean;
}

function faqJsonLd(faqs: { question: string; answer: string }[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  };
}

export const PRERENDER_ROUTES: PrerenderRoute[] = [
  {
    path: "/",
    title:
      "Nanodoc - 100% Free PDF Editor | Combine, Edit, Redact PDFs Online",
    description:
      "100% free PDF editor with no paywalls. Combine PDFs, delete pages, extract pages, add text, highlights, and redact information. Works in your browser or download for Mac and Windows.",
  },
  {
    path: "/why",
    title: "Why Nanodoc Exists | A Truly Free PDF Editor",
    description:
      "Why Nanodoc is free with no paywalls: PDFs are everyday paperwork, and editing them should not need a subscription. Local processing, private by design.",
  },
  {
    path: "/faq",
    title: "Nanodoc FAQ | Free PDF Editor Questions Answered",
    description:
      "Answers about Nanodoc, the free PDF editor: pricing (free, no paywalls), privacy (files never leave your device), watermarks (none), browsers, and offline use.",
    jsonLd: [faqJsonLd(FAQS)],
  },
  {
    path: "/compare",
    title: "PDF Editor Comparison: Nanodoc vs Adobe, Bluebeam & More",
    description:
      "Honest comparison of PDF editors: Nanodoc, Adobe Acrobat, Bluebeam Revu, PDF-XChange, Apple Preview, and Microsoft Edge. Prices, strengths, and who each fits.",
  },
  {
    path: "/partners",
    title: "Nanodoc Partners",
    description: "Products and teams Nanodoc works with.",
  },
  {
    path: "/privacy",
    title: "Privacy Statement | Nanodoc",
    description:
      "Nanodoc privacy statement. Your PDFs are processed locally and never uploaded to our servers.",
  },
  {
    path: "/terms",
    title: "Terms and Conditions | Nanodoc",
    description: "Terms and conditions for using Nanodoc, the free PDF editor.",
  },
  // Task landing pages
  ...TASKS.map((task) => ({
    path: `/${task.slug}`,
    title: task.title,
    description: task.description,
    jsonLd: [faqJsonLd(task.faqs)],
  })),
  // Competitor-alternative pages
  ...ALTERNATIVES.map((alt) => ({
    path: `/${alt.slug}`,
    title: alt.title,
    description: alt.description,
    jsonLd: [faqJsonLd(alt.faqs)],
  })),
  // App shells: correct meta, empty root
  {
    path: "/editor",
    title: "Nanodoc PDF Editor | Edit PDFs Free in Your Browser",
    description:
      "Open the free Nanodoc PDF editor. Combine, edit, annotate, and redact PDFs in your browser. No sign-up, no watermark.",
    shell: true,
  },
  {
    path: "/stitch",
    title: "Nanodoc Stitch | Arrange PDF Pages on One Canvas",
    description:
      "Open the free Stitch tool: place PDF pages on one canvas, arrange and resize them, and export a single PDF.",
    shell: true,
  },
  {
    path: "/view",
    title: "Nanodoc Viewer",
    description: "Embedded Nanodoc document viewer.",
    shell: true,
    noindex: true,
  },
];
