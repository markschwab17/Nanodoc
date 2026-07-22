// Per-task landing page content. Each entry becomes an indexable route at
// /<slug> plus an entry in the sitemap and the prerendered FAQPage JSON-LD.
//
// Writing rules for this file (they are the reason these pages rank and get
// cited by AI assistants, so hold the line):
//  - The `answer` must directly answer the search query in the first sentence.
//  - Every claim must be true of the shipped product. No overclaiming: if a
//    feature has a limit (pixel-based editing, large-file slowness), the page
//    says so.
//  - No em dashes, no buzzwords (see the brand voice playbook).
export interface TaskFaq {
  question: string;
  answer: string;
}

export interface TaskPageDef {
  slug: string;
  /** <title> tag, keyword first */
  title: string;
  /** meta description, <=160 chars */
  description: string;
  h1: string;
  /** Direct answer paragraph shown under the H1 and used by answer engines */
  answer: string;
  steps: string[];
  faqs: TaskFaq[];
  /** Where the CTA button sends the visitor */
  ctaPath: string;
  ctaLabel: string;
  /** Slugs of related task pages, for internal linking */
  related: string[];
}

export const TASKS: TaskPageDef[] = [
  {
    slug: "combine-pdf",
    title: "Combine PDF Files Free, No Sign-Up | Nanodoc",
    description:
      "Combine PDF files into one document for free. No sign-up, no watermark, and your files never leave your device. Works in your browser.",
    h1: "Combine PDF files for free",
    answer:
      "Merge two or more PDFs into a single document right in your browser. There is no sign-up, no watermark, and no page-count paywall, and your files are processed on your device instead of being uploaded to a server.",
    steps: [
      "Open the free editor. No account is needed.",
      "Drag and drop your first PDF, or click Browse Files.",
      "Use the Combine PDFs tool to add the other files.",
      "Arrange the pages in the order you want.",
      "Download your combined PDF.",
    ],
    faqs: [
      {
        question: "Is there a limit on how many PDFs I can combine?",
        answer:
          "There is no fixed limit on file count. Very large jobs (over 100MB total) may process slowly in the browser; the free desktop version handles large files more efficiently.",
      },
      {
        question: "Will the combined PDF have a watermark?",
        answer:
          "No. Nanodoc never adds a watermark or any branding to your documents.",
      },
      {
        question: "Are my files uploaded to a server?",
        answer:
          "No. Combining happens locally in your browser or on your device. Your files never leave your computer.",
      },
    ],
    ctaPath: "/editor",
    ctaLabel: "Combine PDFs now",
    related: ["delete-pdf-pages", "extract-pdf-pages", "stitch-pdf"],
  },
  {
    slug: "delete-pdf-pages",
    title: "Delete Pages from a PDF Free | Nanodoc",
    description:
      "Delete pages from a PDF for free, in your browser. No sign-up, no watermark, files stay on your device. Remove one page or many at once.",
    h1: "Delete pages from a PDF for free",
    answer:
      "Remove unwanted pages from any PDF in your browser and download the cleaned-up file. No sign-up, no watermark, and the file never leaves your device.",
    steps: [
      "Open the free editor and load your PDF.",
      "Open the page panel to see every page as a thumbnail.",
      "Select the pages you want to remove and delete them.",
      "Download the updated PDF.",
    ],
    faqs: [
      {
        question: "Can I delete multiple pages at once?",
        answer:
          "Yes. Select as many pages as you need in the page panel and remove them in one action.",
      },
      {
        question: "Does deleting pages reduce the quality of the rest of the document?",
        answer:
          "No. The remaining pages are kept as they are; Nanodoc removes the deleted pages without re-rendering the rest of the file.",
      },
      {
        question: "Is this really free?",
        answer:
          "Yes. Every Nanodoc feature is free, with no premium tier and no trial clock.",
      },
    ],
    ctaPath: "/editor",
    ctaLabel: "Delete PDF pages now",
    related: ["extract-pdf-pages", "combine-pdf", "add-text-to-pdf"],
  },
  {
    slug: "extract-pdf-pages",
    title: "Extract Pages from a PDF Free | Nanodoc",
    description:
      "Extract pages from a PDF into a new file, free and in your browser. No sign-up, no watermark, and your document never leaves your device.",
    h1: "Extract pages from a PDF for free",
    answer:
      "Pull specific pages out of a PDF and save them as a new document, right in your browser. No sign-up, no watermark, and the file is processed on your device.",
    steps: [
      "Open the free editor and load your PDF.",
      "Open the page panel and select the pages you want to keep.",
      "Use the Extract tool to create a new PDF from the selection.",
      "Download the new file.",
    ],
    faqs: [
      {
        question: "Can I extract non-consecutive pages?",
        answer:
          "Yes. Select any combination of pages, in any order, and extract them into one new PDF.",
      },
      {
        question: "Does the original PDF change?",
        answer:
          "No. Extracting creates a new document; your original file stays exactly as it was.",
      },
      {
        question: "Are my files uploaded anywhere?",
        answer:
          "No. All processing happens locally in your browser or on your device.",
      },
    ],
    ctaPath: "/editor",
    ctaLabel: "Extract PDF pages now",
    related: ["delete-pdf-pages", "combine-pdf", "stitch-pdf"],
  },
  {
    slug: "redact-pdf",
    title: "Redact a PDF Free | Permanently Remove Text | Nanodoc",
    description:
      "Redact a PDF for free. Nanodoc permanently removes the underlying content, then verifies the text is actually gone. No sign-up, files stay local.",
    h1: "Redact a PDF for free",
    answer:
      "Black out sensitive information and permanently remove the content underneath, free and in your browser. Nanodoc does not just draw a box over the text: it deletes the underlying content and then re-checks the region to verify the text is actually gone. If a PDF's structure defeats redaction, Nanodoc tells you instead of pretending it worked.",
    steps: [
      "Open the free editor and load your PDF.",
      "Select the Redact tool from the toolbar.",
      "Draw over every region you want removed.",
      "Apply the redactions. Nanodoc removes the content and verifies the text is gone.",
      "Download the redacted PDF.",
    ],
    faqs: [
      {
        question: "Is the redacted text really removed, or just covered up?",
        answer:
          "Really removed. Drawing a black rectangle over text leaves the text selectable and searchable underneath, which has caused real-world data leaks. Nanodoc applies true redaction that deletes the underlying content, then extracts the text in that region afterward to confirm nothing survived.",
      },
      {
        question: "What happens if the redaction cannot be applied safely?",
        answer:
          "Nanodoc warns you. If the verification step finds text still present in a redacted area, you get an error instead of a false sense of security.",
      },
      {
        question: "Do redacted files get uploaded for processing?",
        answer:
          "No. Redaction runs locally in your browser or on your device, which matters most for exactly the kind of sensitive documents that need redacting.",
      },
    ],
    ctaPath: "/editor?tool=redact",
    ctaLabel: "Redact a PDF now",
    related: ["add-text-to-pdf", "fill-and-sign-pdf", "delete-pdf-pages"],
  },
  {
    slug: "stitch-pdf",
    title: "Stitch PDF Pages onto One Sheet | Nanodoc",
    description:
      "Stitch multiple PDF pages onto a single canvas and export one PDF. Remove white backgrounds, erase elements, arrange freely. Free, no sign-up.",
    h1: "Stitch PDF pages onto one sheet",
    answer:
      "Place pages from one or more PDFs onto a single canvas, arrange them freely, and export the result as one PDF. You can strip white backgrounds so only the drawn content comes in, erase individual lines and shapes, then position, resize, rotate, snap, and crop each piece. Most PDF tools can merge files back to back; stitching them onto one sheet is what Nanodoc does that they do not.",
    steps: [
      "Open the Stitch tool.",
      "Add pages from your PDFs. Optionally remove white backgrounds on import.",
      "Drag, resize, and rotate each tile; use snapping and alignment tools to line things up.",
      "Erase any individual elements you do not want.",
      "Export the canvas as a single PDF, or open it in the editor to keep working.",
    ],
    faqs: [
      {
        question: "How is stitching different from combining PDFs?",
        answer:
          "Combining appends whole pages one after another into one document. Stitching places multiple pages onto the same sheet, so you can build one large layout, like a plan set assembled from separate sheets, or put several scanned pages side by side.",
      },
      {
        question: "Who is this for?",
        answer:
          "Anyone who needs several PDF pages on one sheet. It gets heavy use on construction drawings, where plan sets arrive split across sheets that belong together, but it works the same for scans, schematics, and handouts.",
      },
      {
        question: "Is Stitch free too?",
        answer:
          "Yes. Stitch is part of Nanodoc and completely free, like every other feature.",
      },
    ],
    ctaPath: "/stitch",
    ctaLabel: "Stitch PDFs now",
    related: ["combine-pdf", "extract-pdf-pages", "delete-pdf-pages"],
  },
  {
    slug: "add-text-to-pdf",
    title: "Add Text to a PDF Free | Nanodoc",
    description:
      "Add text to any PDF for free, in your browser. Place text anywhere, plus highlights and stamps. No sign-up, no watermark, files stay local.",
    h1: "Add text to a PDF for free",
    answer:
      "Type new text anywhere on any PDF page, free and in your browser. One honest limitation to know up front: Nanodoc is a pixel-based editor, so it adds new text on top of the page; it cannot rewrite text that is already part of the document. For filling in forms, labeling drawings, and annotating documents, that is exactly what you need.",
    steps: [
      "Open the free editor and load your PDF.",
      "Select the Text tool from the toolbar.",
      "Click where you want the text and start typing.",
      "Adjust size, color, and position until it sits right.",
      "Download the updated PDF.",
    ],
    faqs: [
      {
        question: "Can I edit the text that is already in the PDF?",
        answer:
          "No, and we would rather tell you that here than after you load your file. Nanodoc works with the rendered image of each page, so existing text is not editable as text. You can add new text on top, cover old text with a redaction or a filled shape, or use a vector-based editor if you need to rewrite existing paragraphs.",
      },
      {
        question: "Can I also highlight and stamp the document?",
        answer:
          "Yes. Nanodoc includes highlighting with customizable colors, text and image stamps, and a drawn signature tool alongside the text tool.",
      },
      {
        question: "Is the added text searchable?",
        answer:
          "Text you add is embedded into the exported PDF as real content placed over the page image, so it travels with the document.",
      },
    ],
    ctaPath: "/editor?tool=text",
    ctaLabel: "Add text to a PDF now",
    related: ["fill-and-sign-pdf", "redact-pdf", "delete-pdf-pages"],
  },
  {
    slug: "fill-and-sign-pdf",
    title: "Fill and Sign a PDF Free | Nanodoc",
    description:
      "Fill out and sign PDFs free. Draw your signature, add text, and create fillable form fields others can complete. No sign-up, files stay local.",
    h1: "Fill and sign a PDF for free",
    answer:
      "Complete PDF paperwork without a subscription: add text into forms, draw or place your signature, and stamp documents, all in your browser. You can also create fillable form fields, like text boxes, checkboxes, and dropdowns, so other people can complete your form in their own PDF reader. No sign-up, no watermark, and files stay on your device.",
    steps: [
      "Open the free editor and load your PDF form.",
      "Use the Text tool to fill in your answers.",
      "Draw your signature with the signature tool, or place a saved image of it.",
      "If you are building a form for others, add fillable fields where responses go.",
      "Download the finished PDF.",
    ],
    faqs: [
      {
        question: "Is a drawn signature legally valid?",
        answer:
          "In many everyday situations, yes: most jurisdictions accept electronic signatures for routine documents. Nanodoc places your signature on the document but is not a certificate-based e-signing service, so for contracts that require identity verification and audit trails, use a dedicated e-signature platform.",
      },
      {
        question: "Can other people fill out the forms I create?",
        answer:
          "Yes. Fillable fields you add are saved as standard PDF form fields, so recipients can complete them in common PDF readers.",
      },
      {
        question: "Do I need an account to sign a document?",
        answer: "No. There is no sign-up and no login. Open the editor and sign.",
      },
    ],
    ctaPath: "/editor?tool=text",
    ctaLabel: "Fill and sign a PDF now",
    related: ["add-text-to-pdf", "redact-pdf", "combine-pdf"],
  },
];

export const TASK_SLUGS = TASKS.map((t) => t.slug);

export function getTask(slug: string): TaskPageDef | undefined {
  return TASKS.find((t) => t.slug === slug);
}
