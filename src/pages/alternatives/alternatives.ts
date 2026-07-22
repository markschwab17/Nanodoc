// Competitor-alternative landing pages, targeting "X alternative" switcher
// searches. Same writing rules as tasks.ts, with one extra that matters even
// more here: name where the competitor is BETTER, plainly. These pages only
// convert (and only get cited by AI assistants) because they are honest
// comparisons, not takedowns. Nanodoc does not convert file formats, edit
// existing vector text, or OCR; every page that touches those says so.
export interface AltFaq {
  question: string;
  answer: string;
}

export interface AlternativePageDef {
  slug: string;
  competitor: string;
  title: string;
  description: string;
  h1: string;
  answer: string;
  /** Cases where Nanodoc is the right swap */
  nanodocFor: string[];
  /** Cases where the competitor stays the better tool */
  competitorFor: string[];
  faqs: AltFaq[];
  related: string[];
}

const LOCAL_PRIVACY_FAQ: AltFaq = {
  question: "Are my files uploaded to a server?",
  answer:
    "Not with Nanodoc. All processing happens locally in your browser or in the free desktop app, so your documents never leave your device. Most online PDF tools upload your file to their servers to process it.",
};

const REALLY_FREE_FAQ: AltFaq = {
  question: "Is Nanodoc really free, or is there a catch?",
  answer:
    "Really free. There is no premium tier, no trial clock, no daily task limit, no watermark, and no account. The project is supported by optional donations.",
};

export const ALTERNATIVES: AlternativePageDef[] = [
  {
    slug: "adobe-acrobat-alternative",
    competitor: "Adobe Acrobat",
    title: "Free Adobe Acrobat Alternative | Nanodoc",
    description:
      "Nanodoc is a free Adobe Acrobat alternative for combining, annotating, redacting, and signing PDFs. No subscription, no account, files stay on your device.",
    h1: "A free Adobe Acrobat alternative",
    answer:
      "If Acrobat's $19.99 a month is buying you page management, annotation, form filling, signing, and redaction, Nanodoc does those for free, in your browser, without an Adobe account, and without your files leaving your device. If it is buying you OCR, editing of existing text, or certificate-based signatures, keep Acrobat: Nanodoc does not do those, and we would rather you know before you switch.",
    nanodocFor: [
      "Combining PDFs and managing pages without a subscription",
      "Adding text, highlights, stamps, and drawn signatures",
      "True redaction that removes content and verifies it is gone",
      "Creating fillable form fields others can complete",
      "Working on documents that should not be uploaded anywhere",
    ],
    competitorFor: [
      "Rewriting text that is already in the document (vector editing)",
      "OCR on scanned documents",
      "Certificate-based digital signatures with audit trails",
      "Enterprise document workflows and Creative Cloud integration",
    ],
    faqs: [
      REALLY_FREE_FAQ,
      {
        question: "Can Nanodoc edit existing text like Acrobat does?",
        answer:
          "No. Nanodoc is pixel-based: it adds new content on top of pages but cannot rewrite text that is already part of the document. If existing-text editing is your main use, Acrobat or PDF-XChange is the better tool.",
      },
      LOCAL_PRIVACY_FAQ,
    ],
    related: ["combine-pdf", "redact-pdf", "fill-and-sign-pdf"],
  },
  {
    slug: "smallpdf-alternative",
    competitor: "Smallpdf",
    title: "Free Smallpdf Alternative, No Task Limits | Nanodoc",
    description:
      "Nanodoc is a free Smallpdf alternative with no daily task limits and no uploads: combine, edit, redact, and sign PDFs locally in your browser.",
    h1: "A free Smallpdf alternative",
    answer:
      "Smallpdf's free tier limits how many tasks you can run per day and processes your files on its servers. Nanodoc has no task limits, no account, and no uploads: everything runs locally in your browser. The honest trade: Smallpdf's converters (PDF to Word, JPG, Excel and back) are its real strength, and Nanodoc does not convert file formats at all. For editing, combining, page management, redaction, and signing, you do not need to hand your file to a server.",
    nanodocFor: [
      "Unlimited combining, page edits, and annotation, no daily cap",
      "Documents too sensitive to upload: everything stays on your device",
      "Redaction, fillable form fields, and drawn signatures for free",
      "Stitching pages onto one sheet, which no converter site offers",
    ],
    competitorFor: [
      "Converting PDFs to Word, Excel, PowerPoint, or images and back",
      "Compressing PDFs to hit a file-size target",
      "OCR on scanned documents",
    ],
    faqs: [
      {
        question: "Does Nanodoc convert PDF to Word?",
        answer:
          "No. Nanodoc is an editor, not a converter. It combines, edits, annotates, redacts, and signs PDFs, but it does not convert between file formats. For conversions, a tool like Smallpdf or iLovePDF is the right choice.",
      },
      REALLY_FREE_FAQ,
      LOCAL_PRIVACY_FAQ,
    ],
    related: ["combine-pdf", "delete-pdf-pages", "add-text-to-pdf"],
  },
  {
    slug: "ilovepdf-alternative",
    competitor: "iLovePDF",
    title: "Free iLovePDF Alternative, No Uploads | Nanodoc",
    description:
      "Nanodoc is a free iLovePDF alternative that processes PDFs on your device instead of a server. Combine, edit, redact, and sign with no limits or account.",
    h1: "A free iLovePDF alternative",
    answer:
      "iLovePDF is a capable toolbox, but the free tier caps file sizes and tasks, and your documents are processed on its servers. Nanodoc runs entirely on your device: no upload, no account, no task caps, no watermark. The honest trade: iLovePDF converts between formats (Word, Excel, JPG) and compresses files, which Nanodoc does not do. For the editing half of the job, combining, page management, annotation, redaction, and signing, Nanodoc covers it free and local.",
    nanodocFor: [
      "Editing and combining without file-size or task caps",
      "Confidential documents that should never touch a third-party server",
      "True verified redaction and fillable form fields",
      "A desktop app for Mac and Windows, also free",
    ],
    competitorFor: [
      "Converting PDFs to and from Word, Excel, and images",
      "Compressing PDFs",
      "OCR on scanned documents",
    ],
    faqs: [
      {
        question: "What can iLovePDF do that Nanodoc cannot?",
        answer:
          "Format conversion (PDF to Word, Excel, JPG and back), compression, and OCR. Nanodoc focuses on editing: combining, page management, annotation, redaction, signing, and stitching pages onto one sheet.",
      },
      LOCAL_PRIVACY_FAQ,
      REALLY_FREE_FAQ,
    ],
    related: ["combine-pdf", "extract-pdf-pages", "redact-pdf"],
  },
  {
    slug: "bluebeam-alternative",
    competitor: "Bluebeam Revu",
    title: "Free Bluebeam Alternative for Plan Markup | Nanodoc",
    description:
      "Nanodoc is a free Bluebeam alternative for plan set page management and markup: combine sheets, stitch pages onto one canvas, annotate, and redact.",
    h1: "A free Bluebeam alternative for plan markup",
    answer:
      "Bluebeam Revu earns its $360 a year when you need takeoff, measurement, and Studio collaboration. But if a seat is mostly opening plan sets, pulling sheets, marking up, and passing PDFs around, Nanodoc handles that for free. It also does one thing Revu does not: stitching multiple sheets onto a single canvas, with white backgrounds stripped, to build one combined plan sheet.",
    nanodocFor: [
      "Combining, splitting, and reordering plan set sheets",
      "Stitching sheets onto one canvas to build a single combined sheet",
      "Markup: text, highlights, stamps, and drawn signatures",
      "Seats that view and annotate but do not do takeoff",
    ],
    competitorFor: [
      "Measurement and takeoff with scaled drawings",
      "Studio sessions for real-time multi-user markup",
      "OCR and searchable scanned plan sets",
      "Tool sets, custom columns, and construction-specific workflows",
    ],
    faqs: [
      {
        question: "Can Nanodoc do takeoff or measurements?",
        answer:
          "No. Nanodoc has no scale or measurement tools. For takeoff, keep Revu or use a dedicated takeoff product. Nanodoc covers the page management and markup side: combining sheets, extracting pages, annotating, and stitching sheets onto one canvas.",
      },
      {
        question: "What is sheet stitching?",
        answer:
          "Nanodoc's Stitch tool places pages from one or more PDFs onto a single canvas. You can strip white backgrounds so only the linework imports, erase individual elements, then arrange, resize, rotate, and export everything as one PDF sheet. It is built for plan sets that arrive split across sheets that belong together.",
      },
      REALLY_FREE_FAQ,
    ],
    related: ["stitch-pdf", "combine-pdf", "extract-pdf-pages"],
  },
];

export const ALTERNATIVE_SLUGS = ALTERNATIVES.map((a) => a.slug);

export function getAlternative(slug: string): AlternativePageDef | undefined {
  return ALTERNATIVES.find((a) => a.slug === slug);
}
