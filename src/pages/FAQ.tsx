import { NavBar } from "@/features/navigation/NavBar";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

function FAQ() {
  const faqs = [
    {
      question: "Is Nanodoc really 100% free?",
      answer:
        "Yes! Nanodoc is completely free to use with no paywalls, hidden fees, or premium features. All functionality is available to everyone at no cost.",
    },
    {
      question: "What features are available?",
      answer:
        "Nanodoc offers a comprehensive set of PDF editing features including: combining multiple PDFs into one document, deleting unwanted pages, extracting specific pages, adding text annotations, highlighting text with customizable colors, and redacting sensitive information. All features are available for free.",
    },
    {
      question: "Is Nanodoc a pixel-based or vector-based PDF editor?",
      answer:
        "Nanodoc is a pixel-based PDF editor, not a vector-based editor. This means that the editor works with the rendered image of your PDF pages rather than the underlying vector graphics. While this approach provides excellent compatibility and works with all PDF types, it means that text and graphics are treated as images rather than editable vector objects.",
    },
    {
      question: "How do I use the PDF editor?",
      answer:
        "Using Nanodoc is simple! Click the 'Start Editing PDFs Now' button on the home page, then either drag and drop a PDF file into the editor or click 'Browse Files' to select a PDF from your computer. Once your PDF is loaded, you can use the toolbar on the right to access all editing features.",
    },
    {
      question: "What's the difference between the web and desktop versions?",
      answer:
        "The web version works directly in your browser—no installation required. It's perfect for quick edits and works on any device with a modern browser. The desktop versions (Mac and Windows) offer the same features with the added convenience of a native application. Both versions are completely free.",
    },
    {
      question: "Which browsers are supported?",
      answer:
        "Nanodoc works best in modern browsers including Chrome, Firefox, Safari, and Edge. For the best experience, we recommend using the latest version of your browser. The editor uses WebAssembly for PDF processing, which is supported by all major modern browsers.",
    },
    {
      question: "Is my data private and secure?",
      answer:
        "Yes! All PDF processing happens locally in your browser or on your device. Your files are never uploaded to our servers, ensuring complete privacy and security. We don't store, track, or have access to your documents.",
    },
    {
      question: "Can I edit PDFs offline?",
      answer:
        "The web version requires an internet connection to load initially, but once loaded, most features work offline. For true offline editing, we recommend downloading the desktop version, which works completely offline after installation.",
    },
    {
      question: "Are there file size limits?",
      answer:
        "The web version can handle most PDF files, but very large files (over 100MB) may take longer to process. The desktop version has fewer limitations and can handle larger files more efficiently. If you encounter issues with large files, try the desktop version.",
    },
    {
      question: "How can I support Nanodoc?",
      answer:
        "Nanodoc is free to use, but if you find it helpful, you can support the project by making a donation through PayPal. Donations help cover hosting costs and support continued development. You can find the donation button on the home page.",
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
      <NavBar />
      
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl md:text-5xl font-bold text-center mb-4">
            Frequently Asked Questions
          </h1>
          <p className="text-xl text-muted-foreground text-center mb-12">
            Everything you need to know about Nanodoc
          </p>
          
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq, index) => (
              <AccordionItem key={index} value={`item-${index}`}>
                <AccordionTrigger className="text-left">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
          
          <div className="mt-12 text-center">
            <p className="text-muted-foreground mb-4">
              Still have questions?
            </p>
            <a
              href="mailto:support@nanodoc.app"
              className="text-primary hover:underline"
            >
              Contact us
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

export default FAQ;

