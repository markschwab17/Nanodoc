/**
 * Notification Toast Component
 * 
 * Displays temporary notifications at the top of the screen.
 */

import { useNotificationStore } from "@/shared/stores/notificationStore";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function NotificationToast() {
  const { notifications, removeNotification } = useNotificationStore();

  if (notifications.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className={cn(
            "flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border bg-background min-w-[300px] max-w-md",
            notification.type === "success" && "border-green-500",
            notification.type === "error" && "border-red-500",
            notification.type === "info" && "border-blue-500"
          )}
        >
          <div className="flex-1">
            <p className="text-sm font-medium">{notification.message}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => removeNotification(notification.id)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}





