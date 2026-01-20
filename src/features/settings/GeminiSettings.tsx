/**
 * Gemini Settings Component
 * 
 * UI for configuring Google Gemini API key.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Settings, Key, CheckCircle2, AlertCircle } from "lucide-react";
import { getGeminiApiKey, saveGeminiApiKey } from "@/core/ai/GeminiService";

interface GeminiSettingsProps {
  buttonClassName?: string;
  iconClassName?: string;
  showLabel?: boolean;
}

export function GeminiSettings({ buttonClassName, iconClassName, showLabel = false }: GeminiSettingsProps = {}) {
  const [apiKey, setApiKey] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationStatus, setValidationStatus] = useState<"idle" | "valid" | "invalid">("idle");

  useEffect(() => {
    const savedKey = getGeminiApiKey();
    if (savedKey) {
      setApiKey(savedKey);
    }
  }, []);

  const handleSave = () => {
    if (apiKey.trim()) {
      saveGeminiApiKey(apiKey.trim());
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
      // Simple validation: try to make a minimal API call
      const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.trim()}`;
      const response = await fetch(testUrl);

      if (response.ok) {
        setValidationStatus("valid");
        saveGeminiApiKey(apiKey.trim());
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Google Gemini API Configuration
          </DialogTitle>
          <DialogDescription>
            Configure your Google Gemini API key to enable AI-powered spec extraction.
            Get your API key from{" "}
            <a
              href="https://makersuite.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Google AI Studio
            </a>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="api-key">API Key</Label>
            <div className="flex gap-2">
              <Input
                id="api-key"
                type="password"
                placeholder="Enter your Gemini API key"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
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
          <div className="flex justify-end gap-2">
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
