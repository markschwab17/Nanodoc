import { Link } from "react-router-dom";
import { NavBar } from "@/features/navigation/NavBar";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import {
  FileText,
  Combine,
  Trash2,
  FileDown,
  Type,
  Highlighter,
  EyeOff,
  Download,
  ChevronDown,
} from "lucide-react";


// Download URLs configuration
// Exact filenames from GitHub release: https://github.com/markschwab17/nanodoc/releases/tag/v0.1.0
const DOWNLOAD_URLS = {
  macIntel: import.meta.env.VITE_DOWNLOAD_URL_MAC_INTEL || "https://github.com/markschwab17/nanodoc/releases/download/v0.1.0/Nanodoc_0.1.0_x64.dmg",
  macAppleSilicon: import.meta.env.VITE_DOWNLOAD_URL_MAC_APPLE_SILICON || "https://github.com/markschwab17/nanodoc/releases/download/v0.1.0/Nanodoc_0.1.0_aarch64.dmg",
  windows: import.meta.env.VITE_DOWNLOAD_URL_WINDOWS || "https://github.com/markschwab17/nanodoc/releases/download/v0.1.0/Nanodoc_0.1.0_x64_en-US.msi",
};

// Mac/Apple Logo SVG Component
const MacLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
  </svg>
);

// Windows Logo SVG Component
const WindowsLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>
  </svg>
);

function Home() {
  const [userPlatform, setUserPlatform] = useState<'macIntel' | 'macAppleSilicon' | 'windows' | null>(null);
  const [showMacDropdown, setShowMacDropdown] = useState(false);

  useEffect(() => {
    // Detect user's platform
    const platform = navigator.platform.toLowerCase();
    
    if (platform.includes('mac') || platform.includes('darwin')) {
      // Try to detect Apple Silicon (M1/M2/M3) vs Intel
      // Note: Browser-based detection is limited, so we'll show both options
      // but highlight based on best guess
      const isLikelyAppleSilicon = 
        navigator.hardwareConcurrency >= 8 || // Apple Silicon often has 8+ cores
        (navigator as any).userAgentData?.platform === 'macOS';
      
      setUserPlatform(isLikelyAppleSilicon ? 'macAppleSilicon' : 'macIntel');
    } else if (platform.includes('win')) {
      setUserPlatform('windows');
    }
  }, []);

  const handleDownload = (url: string) => {
    // Create a hidden link and trigger download without navigation
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

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
        <div className="max-w-4xl mx-auto text-center">
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
          
          <div className="flex flex-col sm:flex-row gap-6 justify-center items-stretch">
            {/* Mac with Dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowMacDropdown(!showMacDropdown)}
                className={`group flex flex-col items-center justify-center p-8 rounded-lg border-2 transition-all w-[280px] h-[280px] hover:scale-105 active:scale-95 cursor-pointer ${
                  userPlatform === 'macAppleSilicon' || userPlatform === 'macIntel'
                    ? 'border-primary bg-primary/5 shadow-lg shadow-primary/20'
                    : 'border-border bg-card hover:border-primary hover:shadow-lg'
                }`}
              >
                <div className={`w-16 h-16 rounded-lg flex items-center justify-center mb-4 transition-colors ${
                  userPlatform === 'macAppleSilicon' || userPlatform === 'macIntel'
                    ? 'bg-primary/20 group-hover:bg-primary/30'
                    : 'bg-primary/10 group-hover:bg-primary/20'
                }`}>
                  <MacLogo className="h-10 w-10 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-2 text-center">
                  Mac Version
                  {(userPlatform === 'macAppleSilicon' || userPlatform === 'macIntel') && (
                    <span className="ml-2 text-sm text-primary font-normal">(Recommended)</span>
                  )}
                </h3>
                <p className="text-sm text-muted-foreground mb-4 text-center">Select your Mac type</p>
                <div className="flex items-center gap-2 text-primary group-hover:gap-3 transition-all">
                  <Download className="h-5 w-5" />
                  <ChevronDown className="h-4 w-4" />
                </div>
              </button>
              
              {/* Custom Dropdown */}
              {showMacDropdown && (
                <>
                  <div 
                    className="fixed inset-0 z-40" 
                    onClick={() => setShowMacDropdown(false)}
                  />
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 mt-2 w-56 bg-popover border rounded-md shadow-lg z-50 p-1">
                    <div className="flex flex-col">
                      <button
                        onClick={() => {
                          handleDownload(DOWNLOAD_URLS.macAppleSilicon);
                          setShowMacDropdown(false);
                        }}
                        className="flex items-center justify-between px-3 py-2 text-sm rounded-md hover:bg-accent hover:text-accent-foreground transition-colors"
                      >
                        <div className="flex flex-col items-start">
                          <span className="font-medium">M Series chips</span>
                        </div>
                        {userPlatform === 'macAppleSilicon' && (
                          <span className="text-xs text-primary">✓</span>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          handleDownload(DOWNLOAD_URLS.macIntel);
                          setShowMacDropdown(false);
                        }}
                        className="flex items-center justify-between px-3 py-2 text-sm rounded-md hover:bg-accent hover:text-accent-foreground transition-colors"
                      >
                        <div className="flex flex-col items-start">
                          <span className="font-medium">Intel</span>
                          <span className="text-xs text-muted-foreground">Intel-based Macs</span>
                        </div>
                        {userPlatform === 'macIntel' && (
                          <span className="text-xs text-primary">✓</span>
                        )}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
            
            {/* Windows */}
            <button
              onClick={() => handleDownload(DOWNLOAD_URLS.windows)}
              className={`group flex flex-col items-center justify-center p-8 rounded-lg border-2 transition-all w-[280px] h-[280px] hover:scale-105 active:scale-95 cursor-pointer ${
                userPlatform === 'windows'
                  ? 'border-primary bg-primary/5 shadow-lg shadow-primary/20'
                  : 'border-border bg-card hover:border-primary hover:shadow-lg'
              }`}
            >
              <div className={`w-16 h-16 rounded-lg flex items-center justify-center mb-4 transition-colors ${
                userPlatform === 'windows'
                  ? 'bg-primary/20 group-hover:bg-primary/30'
                  : 'bg-primary/10 group-hover:bg-primary/20'
              }`}>
                <WindowsLogo className="h-10 w-10 text-primary" />
              </div>
              <h3 className="text-xl font-semibold mb-2 text-center">
                Windows Version
                {userPlatform === 'windows' && (
                  <span className="ml-2 text-sm text-primary font-normal">(Recommended)</span>
                )}
              </h3>
              <p className="text-sm text-muted-foreground mb-4 text-center">Download for PC</p>
              <div className="flex items-center gap-2 text-primary group-hover:gap-3 transition-all">
                <Download className="h-5 w-5" />
                <span className="text-sm font-medium">Download</span>
              </div>
            </button>
          </div>
          
          <p className="text-sm text-muted-foreground mt-8">
            Desktop app includes all web features plus native file system access
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
              <Link to="/why" className="text-sm text-muted-foreground hover:text-foreground">
                Why
              </Link>
              <Link to="/editor" className="text-sm text-muted-foreground hover:text-foreground">
                Editor
              </Link>
              <Link to="/faq" className="text-sm text-muted-foreground hover:text-foreground">
                FAQ
              </Link>
              <Link to="/compare" className="text-sm text-muted-foreground hover:text-foreground">
                Compare
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

