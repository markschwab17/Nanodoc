/**
 * Save Redlined Version dialog.
 * Shown when saving in contract_redline mode. User can set a custom version name and notes.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Save } from "lucide-react";

interface SaveRedlineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultVersionName: string;
  onSave: (versionName: string, notes: string) => Promise<void>;
  saving: boolean;
}

export function SaveRedlineDialog({
  open,
  onOpenChange,
  defaultVersionName,
  onSave,
  saving,
}: SaveRedlineDialogProps) {
  const [versionName, setVersionName] = useState(defaultVersionName);
  const [notes, setNotes] = useState("");

  const handleSave = async () => {
    await onSave(versionName, notes);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save Redlined Version</DialogTitle>
          <DialogDescription>
            This will save a new version of the contract with your redline annotations.
            The original contract is preserved.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="version-name">Version Name</Label>
            <Input
              id="version-name"
              value={versionName}
              onChange={(e) => setVersionName(e.target.value)}
              placeholder="e.g., Electrical Sub - R1 - 2026-03-22"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Changes made in this revision..."
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !versionName.trim()}>
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Version
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
