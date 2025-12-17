import { NavBar } from "@/features/navigation/NavBar";
import { Link } from "react-router-dom";

function Privacy() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
      <NavBar />
      
      <section className="container mx-auto px-4 py-12 max-w-4xl">
        <h1 className="text-4xl md:text-5xl font-bold mb-8">Privacy Statement</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Last updated: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
        </p>

        <div className="prose prose-slate max-w-none space-y-6 text-foreground">
          <section>
            <h2 className="text-2xl font-semibold mb-4">1. Introduction</h2>
            <p>
              Nanodoc ("we," "our," or "us") is committed to protecting your privacy. This Privacy Statement explains how we handle information when you use our free PDF editor service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">2. Information We Do NOT Collect</h2>
            <p>
              Nanodoc is designed with privacy as a core principle. We do NOT collect, store, or transmit:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Your PDF files or document content</li>
              <li>Personal identification information</li>
              <li>Email addresses or contact information</li>
              <li>Browsing history or usage patterns</li>
              <li>IP addresses or device identifiers</li>
              <li>Cookies or tracking data</li>
              <li>Location data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">3. How Our Service Works</h2>
            <p>
              All PDF processing occurs entirely within your browser or on your local device. Your files never leave your computer or device. We do not have servers that receive, store, or process your documents.
            </p>
            <p>
              When you use the web version, PDF processing happens client-side using WebAssembly technology. No data is transmitted to our servers or any third-party services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">4. Third-Party Services</h2>
            <p>
              Nanodoc does not integrate with third-party analytics, advertising, or tracking services. We do not use cookies, web beacons, or any other tracking technologies.
            </p>
            <p>
              If you choose to make a donation through PayPal, that transaction is handled entirely by PayPal according to their privacy policy. We do not receive or store any payment information.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">5. Contact Information</h2>
            <p>
              If you contact us at <a href="mailto:support@nanodoc.app" className="text-primary hover:underline">support@nanodoc.app</a>, we will only use your email address to respond to your inquiry. We do not store or use this information for any other purpose.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">6. Children's Privacy</h2>
            <p>
              Our service is not directed to children under the age of 13. We do not knowingly collect any information from children under 13. If you believe we have inadvertently collected information from a child under 13, please contact us immediately.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">7. Data Security</h2>
            <p>
              Since we do not collect or store your data, there is no risk of data breaches on our end. All processing happens locally on your device, giving you complete control over your documents.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">8. Changes to This Privacy Statement</h2>
            <p>
              We may update this Privacy Statement from time to time. Any changes will be posted on this page with an updated "Last updated" date. Your continued use of Nanodoc after any changes constitutes acceptance of the updated Privacy Statement.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">9. Your Rights</h2>
            <p>
              Since we do not collect personal information, there is no personal data to access, modify, or delete. You have complete control over your documents and can delete them at any time from your device.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">10. Contact Us</h2>
            <p>
              If you have any questions about this Privacy Statement, please contact us at:
            </p>
            <p className="font-semibold">
              Email: <a href="mailto:support@nanodoc.app" className="text-primary hover:underline">support@nanodoc.app</a>
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t">
          <Link to="/" className="text-primary hover:underline">
            ← Back to Home
          </Link>
        </div>
      </section>
    </div>
  );
}

export default Privacy;



