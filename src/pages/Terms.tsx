import { NavBar } from "@/features/navigation/NavBar";
import { Link } from "react-router-dom";

function Terms() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
      <NavBar />
      
      <section className="container mx-auto px-4 py-12 max-w-4xl">
        <h1 className="text-4xl md:text-5xl font-bold mb-8">Terms and Conditions</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Last updated: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
        </p>

        <div className="prose prose-slate max-w-none space-y-6 text-foreground">
          <section>
            <h2 className="text-2xl font-semibold mb-4">1. Acceptance of Terms</h2>
            <p>
              By accessing and using Nanodoc ("the Service"), you accept and agree to be bound by the terms and provision of this agreement. If you do not agree to these Terms and Conditions, you must not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">2. Description of Service</h2>
            <p>
              Nanodoc is a free, web-based and desktop PDF editor that allows users to combine, edit, annotate, and manipulate PDF documents. The Service is provided "as is" without any warranties or guarantees.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">3. Free Service</h2>
            <p>
              Nanodoc is provided free of charge with no paywalls, hidden fees, or premium features. All functionality is available to all users at no cost. Donations are voluntary and do not affect access to the Service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">4. User Responsibilities</h2>
            <p>You agree to:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Use the Service only for lawful purposes</li>
              <li>Not use the Service to process or distribute illegal, harmful, or offensive content</li>
              <li>Not attempt to reverse engineer, decompile, or disassemble the Service</li>
              <li>Not use the Service in any way that could damage, disable, or impair the Service</li>
              <li>Be responsible for maintaining the security and confidentiality of your documents</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">5. No Warranties</h2>
            <p>
              THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT.
            </p>
            <p>
              We do not warrant that:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>The Service will be uninterrupted, secure, or error-free</li>
              <li>Any defects or errors will be corrected</li>
              <li>The Service is free of viruses or other harmful components</li>
              <li>The results obtained from using the Service will be accurate or reliable</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">6. Limitation of Liability</h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL NANODOC, ITS DEVELOPERS, AFFILIATES, OR LICENSORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Loss of data or documents</li>
              <li>Loss of profits or business opportunities</li>
              <li>Service interruptions or failures</li>
              <li>Errors or inaccuracies in processed documents</li>
              <li>Any other damages arising from your use or inability to use the Service</li>
            </ul>
            <p>
              Our total liability for any claims arising from or related to the Service shall not exceed zero dollars ($0.00), as the Service is provided free of charge.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">7. Data and Privacy</h2>
            <p>
              All PDF processing occurs locally on your device. We do not collect, store, or have access to your documents or personal information. You are solely responsible for:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Backing up your documents</li>
              <li>Ensuring the security of your files</li>
              <li>Complying with applicable data protection laws</li>
            </ul>
            <p>
              Please review our <Link to="/privacy" className="text-primary hover:underline">Privacy Statement</Link> for more information.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">8. Intellectual Property</h2>
            <p>
              The Service, including its original content, features, and functionality, is owned by Nanodoc and is protected by international copyright, trademark, patent, trade secret, and other intellectual property laws.
            </p>
            <p>
              You may not copy, modify, distribute, sell, or lease any part of the Service without our express written permission.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">9. User Content</h2>
            <p>
              You retain all ownership rights to documents you process using the Service. We do not claim any ownership rights to your content.
            </p>
            <p>
              You are responsible for ensuring you have the right to process, edit, or modify any documents you use with the Service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">10. Service Modifications</h2>
            <p>
              We reserve the right to modify, suspend, or discontinue the Service at any time, with or without notice. We shall not be liable to you or any third party for any modification, suspension, or discontinuance of the Service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">11. Indemnification</h2>
            <p>
              You agree to indemnify, defend, and hold harmless Nanodoc, its developers, affiliates, and licensors from and against any and all claims, damages, obligations, losses, liabilities, costs, or debt, and expenses (including but not limited to attorney's fees) arising from:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Your use of the Service</li>
              <li>Your violation of these Terms and Conditions</li>
              <li>Your violation of any third-party rights</li>
              <li>Any content you process using the Service</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">12. Governing Law</h2>
            <p>
              These Terms and Conditions shall be governed by and construed in accordance with the laws of the jurisdiction in which Nanodoc operates, without regard to its conflict of law provisions.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">13. Severability</h2>
            <p>
              If any provision of these Terms and Conditions is found to be unenforceable or invalid, that provision shall be limited or eliminated to the minimum extent necessary, and the remaining provisions shall remain in full force and effect.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">14. Changes to Terms</h2>
            <p>
              We reserve the right to modify these Terms and Conditions at any time. Changes will be posted on this page with an updated "Last updated" date. Your continued use of the Service after any changes constitutes acceptance of the updated Terms and Conditions.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">15. Contact Information</h2>
            <p>
              If you have any questions about these Terms and Conditions, please contact us at:
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

export default Terms;

