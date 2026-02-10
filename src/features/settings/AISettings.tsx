/**
 * AI Settings Component
 * 
 * UI for configuring AI provider (Gemini or ChatGPT) and API keys.
 * Includes step-by-step guides for getting API keys.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Settings, Key, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";
import { useAIProviderStore } from "@/shared/stores/aiProviderStore";
import { validateGeminiApiKey } from "@/core/ai/GeminiService";
import { validateApiKey as validateOpenAIApiKey } from "@/core/ai/OpenAIService";
import type { AIProvider } from "@/core/ai/types";

interface AISettingsProps {
  buttonClassName?: string;
  iconClassName?: string;
  showLabel?: boolean;
}

export function AISettings({ buttonClassName, iconClassName, showLabel = false }: AISettingsProps = {}) {
  const { activeProvider, setActiveProvider, getApiKey, setApiKey } = useAIProviderStore();
  const [apiKey, setApiKeyLocal] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationStatus, setValidationStatus] = useState<"idle" | "valid" | "invalid">("idle");

  useEffect(() => {
    const savedKey = getApiKey(activeProvider);
    if (savedKey) {
      setApiKeyLocal(savedKey);
    } else {
      setApiKeyLocal("");
    }
    setValidationStatus("idle");
  }, [activeProvider, getApiKey]);

  const handleProviderChange = (provider: AIProvider) => {
    setActiveProvider(provider);
    const savedKey = getApiKey(provider);
    setApiKeyLocal(savedKey || "");
    setValidationStatus("idle");
  };

  const handleSave = () => {
    if (apiKey.trim()) {
      setApiKey(activeProvider, apiKey.trim());
      setIsOpen(false);
      setValidationStatus("idle");
    }
  };

  const handleValidate = async () => {
    if (!apiKey.trim()) {
      setValidationStatus("invalid");
      return;
    }

    setIsValidating(true);
    setValidationStatus("idle");

    try {
      let isValid = false;
      if (activeProvider === 'gemini') {
        isValid = await validateGeminiApiKey(apiKey.trim());
      } else if (activeProvider === 'chatgpt') {
        isValid = await validateOpenAIApiKey(apiKey.trim());
      }

      if (isValid) {
        setValidationStatus("valid");
        setApiKey(activeProvider, apiKey.trim());
      } else {
        setValidationStatus("invalid");
      }
    } catch (error) {
      console.error("API key validation error:", error);
      setValidationStatus("invalid");
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button 
          variant="outline" 
          size={showLabel ? "sm" : "icon"}
          className={showLabel ? "gap-2" : buttonClassName || ""}
          title="AI Settings"
        >
          <Settings className={iconClassName || "h-4 w-4"} />
          {showLabel && "AI Settings"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            AI Provider Configuration
          </DialogTitle>
          <DialogDescription>
            Choose your AI provider and configure your API key to enable AI-powered features.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-4">
          {/* Provider Selection */}
          <div className="space-y-3">
            <Label>AI Provider</Label>
            <RadioGroup value={activeProvider} onValueChange={handleProviderChange}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="gemini" id="gemini" />
                <Label htmlFor="gemini" className="font-normal cursor-pointer">
                  Google Gemini
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="chatgpt" id="chatgpt" />
                <Label htmlFor="chatgpt" className="font-normal cursor-pointer">
                  ChatGPT (OpenAI)
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* API Key Input */}
          <div className="space-y-2">
            <Label htmlFor="api-key">
              {activeProvider === 'gemini' ? 'Gemini' : 'OpenAI'} API Key
            </Label>
            <div className="flex gap-2">
              <Input
                id="api-key"
                type="password"
                placeholder={`Enter your ${activeProvider === 'gemini' ? 'Gemini' : 'OpenAI'} API key`}
                value={apiKey}
                onChange={(e) => {
                  setApiKeyLocal(e.target.value);
                  setValidationStatus("idle");
                }}
                className="flex-1"
              />
              <Button
                onClick={handleValidate}
                disabled={isValidating || !apiKey.trim()}
                variant="outline"
              >
                {isValidating ? "Validating..." : "Validate"}
              </Button>
            </div>
            {validationStatus === "valid" && (
              <div className="flex items-center gap-2 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                API key is valid
              </div>
            )}
            {validationStatus === "invalid" && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle className="h-4 w-4" />
                Invalid API key. Please check and try again.
              </div>
            )}
          </div>

          {/* Step-by-Step Guide */}
          <div className="space-y-2">
            <Label>How to Get Your API Key</Label>
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="guide">
                <AccordionTrigger className="text-sm">
                  Step-by-step guide for {activeProvider === 'gemini' ? 'Gemini' : 'ChatGPT'}
                </AccordionTrigger>
                <AccordionContent className="pt-4 space-y-4">
                  {activeProvider === 'gemini' ? (
                    <div className="space-y-3 text-sm">
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">1</span>
                          Go to Google AI Studio
                        </div>
                        <p className="text-muted-foreground ml-8">
                          Visit{" "}
                          <a
                            href="https://makersuite.google.com/app/apikey"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline inline-flex items-center gap-1"
                          >
                            Google AI Studio
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </p>
                      </div>
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">2</span>
                          Sign in with your Google account
                        </div>
                        <p className="text-muted-foreground ml-8">
                          Use your Google account to sign in. If you don't have one, create a free account.
                        </p>
                      </div>
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">3</span>
                          Create an API key
                        </div>
                        <p className="text-muted-foreground ml-8">
                          Click "Create API Key" button. You can create a new key or use an existing one.
                        </p>
                      </div>
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">4</span>
                          Copy your API key
                        </div>
                        <p className="text-muted-foreground ml-8">
                          Copy the generated API key and paste it in the field above. The key starts with "AIza...".
                        </p>
                      </div>
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">5</span>
                          Validate and save
                        </div>
                        <p className="text-muted-foreground ml-8">
                          Click "Validate" to test your key, then click "Save" to store it securely.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3 text-sm">
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 text-xs font-bold">1</span>
                          Go to OpenAI Platform
                        </div>
                        <p className="text-muted-foreground ml-8">
                          Visit{" "}
                          <a
                            href="https://platform.openai.com/api-keys"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline inline-flex items-center gap-1"
                          >
                            OpenAI API Keys
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </p>
                      </div>
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 text-xs font-bold">2</span>
                          Sign in or create an account
                        </div>
                        <p className="text-muted-foreground ml-8">
                          Sign in with your OpenAI account. If you don't have one, create a free account at{" "}
                          <a
                            href="https://platform.openai.com/signup"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            platform.openai.com
                          </a>
                          .
                        </p>
                      </div>
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 text-xs font-bold">3</span>
                          Add payment method (if needed)
                        </div>
                        <p className="text-muted-foreground ml-8">
                          OpenAI requires a payment method to use the API. Go to{" "}
                          <a
                            href="https://platform.openai.com/account/billing"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            Billing
                          </a>
                          {" "}and add a payment method. You'll get free credits to start.
                        </p>
                      </div>
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 text-xs font-bold">4</span>
                          Create an API key
                        </div>
                        <p className="text-muted-foreground ml-8">
                          Click "Create new secret key" button. Give it a name (e.g., "Nanodoc") and click "Create secret key".
                        </p>
                      </div>
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 text-xs font-bold">5</span>
                          Copy your API key immediately
                        </div>
                        <p className="text-muted-foreground ml-8">
                          <strong>Important:</strong> Copy the API key immediately - you won't be able to see it again! The key starts with "sk-...".
                        </p>
                      </div>
                      <div className="space-y-1">
                        <div className="font-medium flex items-center gap-2">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 text-xs font-bold">6</span>
                          Paste and validate
                        </div>
                        <p className="text-muted-foreground ml-8">
                          Paste the API key in the field above, click "Validate" to test it, then click "Save".
                        </p>
                      </div>
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!apiKey.trim()}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
