#import <Cocoa/Cocoa.h>
#import <Foundation/Foundation.h>

// Global function pointer to Rust callback
extern void (*file_opened_callback)(const char*);

// AppDelegate class to handle Apple Events
@interface AppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    // Register for Apple Events
    [[NSAppleEventManager sharedAppleEventManager] setEventHandler:self
                                                       andSelector:@selector(handleOpenFiles:)
                                                     forEventClass:kCoreEventClass
                                                        andEventID:kAEOpenDocuments];
}

// Handle file opening events from double-click or file association
- (void)handleOpenFiles:(NSAppleEventDescriptor *)event {
    NSAppleEventDescriptor *filesDescriptor = [event paramDescriptorForKeyword:keyDirectObject];

    if (filesDescriptor) {
        // Get all file URLs
        for (NSInteger i = 1; i <= [filesDescriptor numberOfItems]; i++) {
            NSAppleEventDescriptor *fileDescriptor = [filesDescriptor descriptorAtIndex:i];
            NSString *filePath = [[fileDescriptor stringValue] stringByRemovingPercentEncoding];

            if (filePath) {
                // Call the Rust callback with the file path
                if (file_opened_callback) {
                    file_opened_callback([filePath UTF8String]);
                }
            }
        }
    }
}

@end

// Global reference to keep the delegate alive
static AppDelegate *globalDelegate = nil;

// Function to set up the app delegate
void setup_app_delegate(void (*callback)(const char*)) {
    file_opened_callback = callback;

    // Create and set the app delegate
    globalDelegate = [[AppDelegate alloc] init];
    [NSApp setDelegate:globalDelegate];
}
