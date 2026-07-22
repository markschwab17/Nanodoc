import { NavBar } from "@/features/navigation/NavBar";
import { MarketingFooter } from "@/shared/components/MarketingFooter";
import { usePageMeta } from "@/shared/hooks/usePageMeta";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { FAQS } from "./faqData";

function FAQ() {
  usePageMeta(
    "Nanodoc FAQ | Free PDF Editor Questions Answered",
    "Answers about Nanodoc, the free PDF editor: pricing (free, no paywalls), privacy (files never leave your device), watermarks (none), browsers, and offline use.",
  );

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

          {/* All items are open by default so every answer is present in the
              prerendered HTML (collapsed Radix content is unmounted, which
              would hide it from crawlers). Visitors can still collapse them. */}
          <Accordion
            type="multiple"
            defaultValue={FAQS.map((_, index) => `item-${index}`)}
            className="w-full"
          >
            {FAQS.map((faq, index) => (
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
            <p className="text-muted-foreground mb-4">Still have questions?</p>
            <a
              href="mailto:Markschwab@civiltakeoff.ai"
              className="text-primary hover:underline"
            >
              Contact us
            </a>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

export default FAQ;
