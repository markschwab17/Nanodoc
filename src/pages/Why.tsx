import { NavBar } from "@/features/navigation/NavBar";

function Why() {
  return (
    <div className="min-h-screen bg-background">
      <NavBar />

      {/* Header Section */}
      <section className="container mx-auto px-4 py-20 md:py-32 relative">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-5xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
            Why Nanodoc Exists
          </h1>

          <p className="text-2xl md:text-3xl font-semibold text-primary mb-4">
            100% Free PDF Editor
          </p>

          <p className="text-lg md:text-xl text-muted-foreground mb-12 max-w-2xl mx-auto">
            "No free lunch" doesn't apply here. This is truly free.
          </p>
        </div>
      </section>

      {/* Mission Section */}
      <section className="container mx-auto px-4 py-20 bg-gradient-to-br from-primary/5 to-secondary/5">
        <div className="max-w-4xl mx-auto">
          <div className="prose prose-lg max-w-none mx-auto">
            <div className="bg-card/50 backdrop-blur-sm rounded-xl p-8 md:p-12 border shadow-lg">
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold mb-4 text-primary">
                  Our Mission
                </h2>
                <p className="text-lg text-muted-foreground leading-relaxed mb-6">
                  "No free lunch" doesn't apply here. This is truly free.
                </p>
              </div>

              <div className="space-y-6 text-muted-foreground leading-relaxed">
                <p className="text-lg">
                  PDFs are a core business file type that everyone uses. But they've bled into our personal lives as well.
                  Now we're expected to fill out PDF forms for medical forms, signing up for a potluck, filling in an application for school, and so much more.
                </p>

                <p className="text-lg">
                  I wanted to create something useful, but I didn't want to pay for a subscription to interact with a file type that's used every day.
                  So I built Nanodoc to help everyone out.
                </p>

                <div className="bg-primary/10 rounded-lg p-6 my-8 border-l-4 border-primary">
                  <h3 className="text-xl font-semibold text-foreground mb-3">
                    How It Works
                  </h3>
                  <ul className="space-y-2 text-foreground">
                    <li className="flex items-start">
                      <span className="text-primary mr-2 mt-1">✓</span>
                      <span><strong>Works locally:</strong> All processing happens on your device, not on a server</span>
                    </li>
                    <li className="flex items-start">
                      <span className="text-primary mr-2 mt-1">✓</span>
                      <span><strong>100% free:</strong> No subscriptions, no paywalls, no hidden fees</span>
                    </li>
                    <li className="flex items-start">
                      <span className="text-primary mr-2 mt-1">✓</span>
                      <span><strong>Privacy focused:</strong> Your documents never leave your computer</span>
                    </li>
                    <li className="flex items-start">
                      <span className="text-primary mr-2 mt-1">✓</span>
                      <span><strong>Open source:</strong> Transparent and community-driven development</span>
                    </li>
                  </ul>
                </div>

                <p className="text-lg">
                  If you want to support the website, feel free to use the PayPal link below to donate and help keep it going.
                  Your support helps maintain the project and add new features, but it's completely optional—Nanodoc will always be free.
                </p>
              </div>

              <div className="flex justify-center mt-8">
                <form action="https://www.paypal.com/donate" method="post" target="_top">
                  <input type="hidden" name="hosted_button_id" value="FJF9DKGR546DW" />
                  <input
                    type="image"
                    src="https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif"
                    name="submit"
                    title="PayPal - The safer, easier way to pay online!"
                    alt="Donate with PayPal button"
                    className="cursor-pointer border-0"
                  />
                  <img
                    alt=""
                    src="https://www.paypal.com/en_US/i/scr/pixel.gif"
                    width="1"
                    height="1"
                    className="border-0"
                  />
                </form>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t bg-muted/50 mt-20">
        <div className="container mx-auto px-4 py-8">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="flex items-center space-x-2 mb-4 md:mb-0">
              <img src="/nanodoc-logo.png" alt="Nanodoc" className="h-5 w-5" />
              <span className="font-semibold">Nanodoc</span>
            </div>
            <div className="flex flex-wrap gap-4 justify-center">
              <a href="/" className="text-sm text-muted-foreground hover:text-foreground">
                Home
              </a>
              <a href="/editor" className="text-sm text-muted-foreground hover:text-foreground">
                Editor
              </a>
              <a href="/faq" className="text-sm text-muted-foreground hover:text-foreground">
                FAQ
              </a>
              <a href="/compare" className="text-sm text-muted-foreground hover:text-foreground">
                Compare
              </a>
            </div>
          </div>
          <div className="mt-4 text-center text-sm text-muted-foreground space-y-2">
            <div>
              © {new Date().getFullYear()} Nanodoc. 100% Free. No Paywalls.
            </div>
            <div className="flex flex-wrap gap-4 justify-center">
              <a href="/privacy" className="hover:text-foreground">
                Privacy Statement
              </a>
              <span className="text-muted-foreground">•</span>
              <a href="/terms" className="hover:text-foreground">
                Terms and Conditions
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default Why;
