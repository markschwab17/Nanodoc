import { Link } from "react-router-dom";
import { NavBar } from "@/features/navigation/NavBar";
import { Button } from "@/components/ui/button";
import {
  FileText,
  Combine,
  Trash2,
  FileDown,
  Type,
  Highlighter,
  EyeOff,
  Download,
} from "lucide-react";

function Home() {
  const features = [
    {
      icon: Combine,
      title: "Combine PDFs",
      description: "Merge multiple PDF files into one document effortlessly",
    },
    {
      icon: Trash2,
      title: "Delete Pages",
      description: "Remove unwanted pages from your PDF documents",
    },
    {
      icon: FileDown,
      title: "Extract Pages",
      description: "Extract specific pages to create new PDF files",
    },
    {
      icon: Type,
      title: "Add Text",
      description: "Add text annotations and comments to your PDFs",
    },
    {
      icon: Highlighter,
      title: "Highlights",
      description: "Highlight important sections with customizable colors",
    },
    {
      icon: EyeOff,
      title: "Redact Information",
      description: "Securely redact sensitive information from documents",
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      
      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20 md:py-32 relative">
        {/* PDF Editor Interface Mockup */}
        <div className="hero-interface-mockup">
          <div className="mockup-container">
            {/* Top Toolbar */}
            <div className="mockup-toolbar">
              <div className="mockup-toolbar-left">
                <div className="mockup-doc-title">NanoDoc.pdf</div>
                <div className="mockup-toolbar-icons">
                  <div className="mockup-icon"></div>
                  <div className="mockup-icon"></div>
                  <div className="mockup-icon"></div>
                </div>
              </div>
              <div className="mockup-toolbar-right">
                <div className="mockup-status">Saved</div>
              </div>
            </div>
            
            {/* Main Content Area */}
            <div className="mockup-content">
              {/* Left Sidebar */}
              <div className="mockup-sidebar-left">
                <div className="mockup-search">Q Search PDF...</div>
                <div className="mockup-tabs">
                  <div className="mockup-tab active">Pages</div>
                  <div className="mockup-tab">Q Search</div>
                </div>
                <div className="mockup-thumbnails">
                  <div className="mockup-thumbnail selected"></div>
                  <div className="mockup-thumbnail"></div>
                </div>
              </div>
              
              {/* Document Area */}
              <div className="mockup-document">
                <div className="mockup-doc-header">
                  <div className="mockup-logo">N nanodoc</div>
                </div>
                <div className="mockup-doc-content">
                  <div className="mockup-text-line"></div>
                  <div className="mockup-text-line short"></div>
                  <div className="mockup-text-line"></div>
                  <div className="mockup-text-line medium"></div>
                  <div className="mockup-text-line"></div>
                </div>
              </div>
              
              {/* Right Sidebar */}
              <div className="mockup-sidebar-right">
                <div className="mockup-tool-icon"></div>
                <div className="mockup-tool-icon"></div>
                <div className="mockup-tool-icon"></div>
                <div className="mockup-tool-icon"></div>
                <div className="mockup-tool-icon active"></div>
                <div className="mockup-tool-icon"></div>
                <div className="mockup-tool-icon"></div>
                <div className="mockup-zoom">110%</div>
              </div>
            </div>
            
            {/* Bottom Bar */}
            <div className="mockup-bottom-bar">
              <div className="mockup-bottom-left">Insert Page</div>
              <div className="mockup-bottom-center">Page 1 of 2</div>
              <div className="mockup-bottom-right">
                <div className="mockup-nav-icon"></div>
                <div className="mockup-nav-icon"></div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="max-w-4xl mx-auto text-center relative z-20">
          <h1 className="text-5xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
            100% Free PDF Editor
          </h1>
          
          <p className="text-2xl md:text-3xl font-semibold text-primary mb-4">
            No Paywalls. No Hidden Fees. 100% Free.
          </p>
          
          <p className="text-lg md:text-xl text-muted-foreground mb-12 max-w-2xl mx-auto">
            A lightweight, easy-to-use PDF editor that works right in your browser. 
            Combine PDFs, delete pages, extract pages, add text, highlights, and redact information—all completely free.
          </p>
          
          <Link to="/editor">
            <Button 
              size="lg" 
              className="group relative text-lg px-8 py-6 h-auto mb-8 overflow-hidden
                         transform transition-all duration-300 ease-out
                         hover:scale-105 hover:shadow-2xl hover:shadow-primary/50
                         active:scale-95
                         animate-pulse-glow"
            >
              <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent 
                               -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out z-0" />
              <FileText className="mr-2 h-5 w-5 relative z-10 animate-icon-bounce group-hover:animate-none group-hover:scale-110 group-hover:rotate-12 transition-all duration-300" />
              <span className="relative z-10 font-semibold">Start Editing PDFs Now</span>
            </Button>
          </Link>
          
          <p className="text-sm text-muted-foreground">
            No sign-up required • Works in your browser • 100% free
          </p>
        </div>
      </section>

      {/* Features Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-4xl font-bold text-center mb-4">
            Powerful Features, Simple to Use
          </h2>
          <p className="text-xl text-muted-foreground text-center mb-12">
            Everything you need to edit PDFs, all in one place
          </p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <div
                  key={index}
                  className="p-6 rounded-lg border bg-card hover:shadow-lg transition-shadow"
                >
                  <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                    <Icon className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">{feature.title}</h3>
                  <p className="text-muted-foreground">{feature.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Download Section */}
      <section className="container mx-auto px-4 py-20 bg-muted/50">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-4xl font-bold mb-4">
            Download Desktop Version
          </h2>
          <p className="text-xl text-muted-foreground mb-12">
            Get the full-featured desktop app for Mac or Windows
          </p>
          
          <div className="flex flex-col sm:flex-row gap-6 justify-center items-center">
            <a
              href="#"
              className="group flex flex-col items-center justify-center p-8 rounded-lg border-2 border-border bg-card hover:border-primary hover:shadow-lg transition-all min-w-[200px]"
            >
              <div className="w-16 h-16 rounded-lg bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/20 transition-colors">
                <svg className="h-10 w-10 text-primary" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                </svg>
              </div>
              <h3 className="text-xl font-semibold mb-2">Mac Version</h3>
              <p className="text-sm text-muted-foreground mb-4">Download for macOS</p>
              <Download className="h-5 w-5 text-primary" />
            </a>
            
            <a
              href="#"
              className="group flex flex-col items-center justify-center p-8 rounded-lg border-2 border-border bg-card hover:border-primary hover:shadow-lg transition-all min-w-[200px]"
            >
              <div className="w-16 h-16 rounded-lg bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/20 transition-colors">
                <svg className="h-10 w-10 text-primary" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>
                </svg>
              </div>
              <h3 className="text-xl font-semibold mb-2">Windows Version</h3>
              <p className="text-sm text-muted-foreground mb-4">Download for PC</p>
              <Download className="h-5 w-5 text-primary" />
            </a>
          </div>
          
          <p className="text-sm text-muted-foreground mt-8">
            Desktop versions coming soon. Use the web version for now.
          </p>
        </div>
      </section>

      {/* Donate Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-4xl font-bold mb-4">
            Support Nanodoc
          </h2>
          <p className="text-lg text-muted-foreground mb-8">
            Nanodoc is completely free to use, but if you find it helpful, 
            consider making a donation to help support development and hosting costs.
          </p>
          
          <div className="flex justify-center">
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
              <Link to="/editor" className="text-sm text-muted-foreground hover:text-foreground">
                Editor
              </Link>
              <Link to="/faq" className="text-sm text-muted-foreground hover:text-foreground">
                FAQ
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

export default Home;

