import { NavBar } from "@/features/navigation/NavBar";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  FileText,
  Star,
  CheckCircle,
  ExternalLink,
  Zap,
  Shield,
  Users,
  DollarSign,
  Clock,
  Settings
} from "lucide-react";

// Logo Components
const AppleLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
  </svg>
);

const WindowsLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>
  </svg>
);

const AdobeLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="20" height="20" rx="2" fill="#FF0000"/>
    <path d="M7 7h10v10H7V7z" fill="white"/>
    <path d="M9.5 9.5h5l-2.5 4-2.5-4z" fill="#FF0000"/>
  </svg>
);

const BluebeamLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="3" width="20" height="18" rx="2" fill="#0066CC"/>
    <path d="M6 8h12v8H6V8z" fill="white"/>
    <path d="M8 10h8v4H8v-4z" fill="#0066CC"/>
    <path d="M10 12h4v0h-4z" stroke="white" strokeWidth="2"/>
  </svg>
);

const PDFXChangeLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="20" height="20" rx="2" fill="#4A90E2"/>
    <path d="M6 8h12v8H6V8z" fill="white"/>
    <text x="12" y="14" textAnchor="middle" fill="#4A90E2" fontSize="5" fontFamily="Arial, sans-serif" fontWeight="bold">PDF</text>
    <path d="M8 16h8" stroke="#4A90E2" strokeWidth="1"/>
  </svg>
);

function Compare() {
  const competitors = [
    {
      name: "Windows Native PDF Viewer (Microsoft Edge)",
      logo: <WindowsLogo className="h-8 w-8" />,
      category: "Free Built-in",
      price: "Free with Windows",
      description: "Microsoft Edge includes basic PDF viewing and annotation capabilities that come pre-installed with Windows. It's perfect for users who need simple PDF viewing and basic text addition without installing additional software.",
      strengths: [
        "Comes pre-installed with Windows - no download required",
        "Fast startup and reliable performance",
        "Basic text annotations and highlighting",
        "Seamless integration with Windows ecosystem",
        "Always available and updated automatically"
      ],
      bestFor: "Users who primarily view PDFs and occasionally add simple text annotations",
      link: "https://www.microsoft.com/en-us/edge",
      rating: 3.5
    },
    {
      name: "Apple Preview",
      logo: <AppleLogo className="h-8 w-8" />,
      category: "Free Built-in",
      price: "Free with macOS",
      description: "Apple's Preview application is the default PDF viewer and editor on macOS, offering a comprehensive set of tools for PDF manipulation. It's designed with the macOS user experience in mind and provides reliable performance for everyday PDF tasks.",
      strengths: [
        "Native macOS integration with intuitive interface",
        "Extract pages and create new PDF documents",
        "Fill in PDF forms with ease",
        "Draw, sign, and annotate documents digitally",
        "OCR text recognition for searchable PDFs",
        "No additional cost for Mac users"
      ],
      bestFor: "Mac users who need reliable PDF editing tools that work seamlessly with their operating system",
      link: "https://support.apple.com/guide/preview/welcome/mac",
      rating: 4.0
    },
    {
      name: "Bluebeam Revu",
      logo: <BluebeamLogo className="h-8 w-8" />,
      category: "Professional Subscription",
      price: "$360/year",
      description: "Bluebeam Revu is a powerful PDF solution specifically designed for the architecture, engineering, and construction industries. It offers advanced collaboration features, measurement tools, and extensive markup capabilities that make it indispensable for technical professionals.",
      strengths: [
        "Comprehensive toolset for technical document collaboration",
        "Advanced measurement and takeoff features",
        "Powerful OCR capabilities for scanned documents",
        "Real-time collaboration and markup tools",
        "Extensive customization options for industry-specific workflows",
        "Strong integration with CAD and BIM software"
      ],
      bestFor: "Architecture, engineering, and construction professionals who need industry-specific PDF tools",
      link: "https://www.bluebeam.com/software/revi",
      rating: 4.5
    },
    {
      name: "Adobe Acrobat",
      logo: <AdobeLogo className="h-8 w-8" />,
      category: "Professional Subscription",
      price: "$19.99/month",
      description: "Adobe Acrobat is the industry standard for PDF creation, editing, and management. It offers powerful features for document processing, form creation, and advanced editing capabilities. While it provides comprehensive functionality, it requires a subscription and has some limitations with license management across multiple devices.",
      strengths: [
        "Industry-leading PDF creation and editing capabilities",
        "Advanced form creation and data collection tools",
        "Powerful document conversion and OCR features",
        "Extensive integration with Adobe Creative Cloud",
        "Reliable performance and regular updates",
        "Comprehensive security and compliance features"
      ],
      bestFor: "Businesses and professionals who need enterprise-level PDF processing and form management",
      link: "https://acrobat.adobe.com/us/en/",
      rating: 4.5
    },
    {
      name: "PDF-XChange Editor",
      logo: <PDFXChangeLogo className="h-8 w-8" />,
      category: "One-time Purchase",
      price: "$59.50 (one-time)",
      description: "PDF-XChange Editor offers a robust set of PDF editing tools at an affordable one-time price. It provides most features users need for comprehensive PDF editing without the ongoing costs of subscription services. The perpetual license model makes it particularly attractive for users who want long-term access without recurring fees.",
      strengths: [
        "Reasonable perpetual license with no recurring costs",
        "Comprehensive PDF editing and annotation tools",
        "OCR capabilities for scanned documents",
        "Form creation and editing features",
        "Batch processing capabilities",
        "Regular updates and good customer support"
      ],
      bestFor: "Users seeking a cost-effective, feature-rich PDF editor with a one-time purchase model",
      link: "https://www.pdf-xchange.com/product/pdf-xchange-editor",
      rating: 4.0
    }
  ];

  const renderStars = (rating: number) => {
    return Array.from({ length: 5 }, (_, i) => (
      <Star
        key={i}
        className={`h-4 w-4 ${
          i < Math.floor(rating)
            ? "fill-yellow-400 text-yellow-400"
            : i < rating
            ? "fill-yellow-400/50 text-yellow-400"
            : "text-gray-300"
        }`}
      />
    ));
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
      <NavBar />

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-4xl md:text-5xl font-bold mb-6 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
            PDF Editor Comparison Guide
          </h1>

          <p className="text-xl text-muted-foreground mb-8 max-w-3xl mx-auto">
            Explore different PDF editing solutions to find the best fit for your needs.
            Each option has unique strengths, pricing models, and target audiences.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-12">
            <Link to="/editor">
              <Button size="lg" className="group relative text-lg px-8 py-4 h-auto">
                <FileText className="mr-2 h-5 w-5" />
                Try Nanodoc Free
              </Button>
            </Link>
            <span className="text-muted-foreground">No credit card required</span>
          </div>
        </div>
      </section>

      {/* Nanodoc Highlight */}
      <section className="container mx-auto px-4 py-12 bg-primary/5 rounded-lg mx-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-bold mb-4">Why Choose Nanodoc?</h2>
            <p className="text-lg text-muted-foreground">
              Nanodoc offers all the essential PDF editing features you need, completely free,
              with no subscriptions, paywalls, or hidden fees.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mx-auto mb-4">
                <DollarSign className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-semibold mb-2">100% Free</h3>
              <p className="text-sm text-muted-foreground">No subscriptions or hidden costs</p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mx-auto mb-4">
                <Zap className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-semibold mb-2">Easy to Use</h3>
              <p className="text-sm text-muted-foreground">Intuitive interface for all users</p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mx-auto mb-4">
                <Shield className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-semibold mb-2">Privacy First</h3>
              <p className="text-sm text-muted-foreground">All processing happens locally</p>
            </div>
          </div>
        </div>
      </section>

      {/* Competitors Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-4xl font-bold text-center mb-4">
            Popular PDF Editor Options
          </h2>
          <p className="text-xl text-muted-foreground text-center mb-12">
            A comprehensive overview of leading PDF editing solutions
          </p>

          <div className="space-y-8">
            {competitors.map((competitor, index) => (
              <div
                key={index}
                className="bg-card border rounded-lg p-8 hover:shadow-lg transition-shadow"
              >
                <div className="flex flex-col lg:flex-row gap-6">
                  {/* Header */}
                  <div className="flex-1">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-4">
                        {competitor.logo}
                        <div>
                          <h3 className="text-2xl font-bold mb-1">{competitor.name}</h3>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="px-3 py-1 bg-secondary text-secondary-foreground rounded-full text-sm font-medium">
                              {competitor.category}
                            </span>
                            <span className="text-lg font-semibold text-primary">
                              {competitor.price}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            {renderStars(competitor.rating)}
                            <span className="text-sm text-muted-foreground ml-2">
                              {competitor.rating}/5
                            </span>
                          </div>
                        </div>
                      </div>
                      <a
                        href={competitor.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-primary hover:text-primary/80 transition-colors"
                      >
                        <span className="text-sm font-medium">Visit Website</span>
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>

                    <p className="text-muted-foreground mb-6">
                      {competitor.description}
                    </p>

                    {/* Strengths */}
                    <div className="mb-6">
                      <h4 className="font-semibold mb-3 flex items-center gap-2">
                        <CheckCircle className="h-5 w-5 text-green-500" />
                        Key Strengths
                      </h4>
                      <ul className="space-y-2">
                        {competitor.strengths.map((strength, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm">
                            <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                            <span>{strength}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Best For */}
                    <div>
                      <h4 className="font-semibold mb-2 flex items-center gap-2">
                        <Users className="h-5 w-5 text-blue-500" />
                        Best For
                      </h4>
                      <p className="text-sm text-muted-foreground">{competitor.bestFor}</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Comparison */}
      <section className="container mx-auto px-4 py-20 bg-muted/50">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-4xl font-bold text-center mb-4">
            Feature Comparison Overview
          </h2>
          <p className="text-xl text-muted-foreground text-center mb-12">
            Understanding different pricing models and feature sets
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="bg-card p-6 rounded-lg border">
              <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mb-4">
                <DollarSign className="h-6 w-6 text-green-600" />
              </div>
              <h3 className="text-xl font-semibold mb-2">Free Options</h3>
              <p className="text-muted-foreground mb-4">
                Built-in viewers like Microsoft Edge and Apple Preview offer basic functionality at no cost.
              </p>
              <ul className="space-y-1 text-sm">
                <li>• Basic viewing and annotations</li>
                <li>• Pre-installed on your device</li>
                <li>• Limited advanced features</li>
              </ul>
            </div>

            <div className="bg-card p-6 rounded-lg border">
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4">
                <Clock className="h-6 w-6 text-blue-600" />
              </div>
              <h3 className="text-xl font-semibold mb-2">One-time Purchase</h3>
              <p className="text-muted-foreground mb-4">
                Perpetual licenses like PDF-XChange Editor provide long-term access without recurring fees.
              </p>
              <ul className="space-y-1 text-sm">
                <li>• Pay once, use forever</li>
                <li>• Predictable long-term costs</li>
                <li>• May include free updates</li>
              </ul>
            </div>

            <div className="bg-card p-6 rounded-lg border">
              <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center mb-4">
                <Settings className="h-6 w-6 text-purple-600" />
              </div>
              <h3 className="text-xl font-semibold mb-2">Subscription Services</h3>
              <p className="text-muted-foreground mb-4">
                Adobe Acrobat and Bluebeam offer powerful features through monthly or annual subscriptions.
              </p>
              <ul className="space-y-1 text-sm">
                <li>• Access to latest features</li>
                <li>• Cloud storage and collaboration</li>
                <li>• Ongoing costs and updates</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Call to Action */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-4xl font-bold mb-4">
            Ready to Start Editing PDFs?
          </h2>
          <p className="text-xl text-muted-foreground mb-8">
            Try Nanodoc today and experience powerful PDF editing capabilities completely free.
            No subscriptions, no paywalls, no limitations.
          </p>

          <div className="flex justify-center">
            <Link to="/editor">
              <Button size="lg" className="group relative text-lg px-8 py-4 h-auto">
                <FileText className="mr-2 h-5 w-5" />
                Start Editing PDFs Free
              </Button>
            </Link>
          </div>

          <p className="text-sm text-muted-foreground mt-6">
            Works in your browser • No registration required • 100% free forever
          </p>
        </div>
      </section>
    </div>
  );
}

export default Compare;
