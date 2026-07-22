// Single source of truth for the FAQ page content. The prerender entry also
// builds the /faq FAQPage JSON-LD from this array, so question text here is
// what search engines and AI assistants ingest — keep answers direct and
// honest, first sentence answering the question outright.
export interface FaqEntry {
  question: string;
  answer: string;
}

export const FAQS: FaqEntry[] = [
  {
    question: "Is Nanodoc really 100% free?",
    answer:
      "Yes. Nanodoc is completely free to use with no paywalls, hidden fees, or premium features. All functionality is available to everyone at no cost.",
  },
  {
    question: "Does Nanodoc add a watermark to my PDFs?",
    answer:
      "No. Nanodoc never adds a watermark, stamp, or branding of any kind to your documents. What you export is your document and nothing else.",
  },
  {
    question: "Do I need to create an account?",
    answer:
      "No. There is no sign-up, no login, and no email required. Open the editor and start working.",
  },
  {
    question: "Is Nanodoc open source?",
    answer:
      "Yes. Nanodoc is free software released under the AGPL-3.0 license, the same license as the MuPDF engine it builds on. The full source code is public at github.com/markschwab17/nanodoc, and anyone is free to inspect it, build it, or fork it under the same license.",
  },
  {
    question: "What features are available?",
    answer:
      "Nanodoc offers a full set of PDF editing features: combining multiple PDFs into one document, stitching PDF pages onto a single canvas (remove white backgrounds or erase drawn elements, then arrange, resize, rotate, and export as one PDF), deleting unwanted pages, extracting specific pages, adding text annotations, highlighting with customizable colors, stamps and signatures, fillable form fields, and redacting sensitive information. All features are free.",
  },
  {
    question: "What is the Stitch PDFs feature?",
    answer:
      "Stitch PDFs lets you place multiple PDF pages onto one canvas and export them as a single PDF. When adding pages you can remove white backgrounds so only the content (text, lines, graphics) is imported. On the canvas you can erase individual elements by clicking lines, shapes, or drawn content. Drag to position, resize, and rotate each tile, snap to edges, use alignment tools, and optionally crop. When you are done, download the stitched PDF or open it in the editor. It is ideal for building custom layouts, like construction plan sets, or merging scanned pages onto one sheet.",
  },
  {
    question: "Is Nanodoc a pixel-based or vector-based PDF editor?",
    answer:
      "Nanodoc is a pixel-based PDF editor, not a vector-based editor. It works with the rendered image of your PDF pages rather than the underlying vector objects. This gives excellent compatibility with all PDF types, but it means existing text and graphics are treated as images rather than editable vector objects. You can add new text on top of any page, but Nanodoc cannot rewrite text that is already part of the document.",
  },
  {
    question: "How do I use the PDF editor?",
    answer:
      "Click the 'Start Editing PDFs Now' button on the home page, then drag and drop a PDF into the editor or click 'Browse Files' to select one from your computer. Once your PDF is loaded, the toolbar on the right gives you access to every editing feature.",
  },
  {
    question: "What's the difference between the web and desktop versions?",
    answer:
      "The web version works directly in your browser with no installation, which makes it ideal for quick edits on any device. The desktop versions for Mac and Windows offer the same features as a native application and work fully offline. Both are completely free.",
  },
  {
    question: "Which browsers are supported?",
    answer:
      "Nanodoc works best in modern browsers including Chrome, Firefox, Safari, and Edge. The editor uses WebAssembly for PDF processing, which all major modern browsers support. For the best experience, use the latest version of your browser.",
  },
  {
    question: "Is my data private and secure?",
    answer:
      "Yes. All PDF processing happens locally in your browser or on your device. Your files are never uploaded to our servers. We do not store, track, or have access to your documents.",
  },
  {
    question: "Can I edit PDFs offline?",
    answer:
      "The web version needs an internet connection to load initially, but once loaded most features work offline. For true offline editing, download the desktop version, which works completely offline after installation.",
  },
  {
    question: "Are there file size limits?",
    answer:
      "The web version handles most PDF files, but very large files (over 100MB) may take longer to process. The desktop version has fewer limitations and handles large files more efficiently. If you hit issues with a large file, try the desktop version.",
  },
  {
    question: "How can I support Nanodoc?",
    answer:
      "Nanodoc is free to use, but if you find it helpful you can support the project with a donation through PayPal. Donations cover hosting costs and support continued development. The donation button is on the home page.",
  },
];
