#import <React/RCTBridgeModule.h>
#import <AVFoundation/AVFoundation.h>
#import <EventKit/EventKit.h>
#import <UserNotifications/UserNotifications.h>
#import <UIKit/UIKit.h>
#import <os/log.h>

/**
 * MinimusTools (iOS) — native phone-control tools for the agent.
 * Mirrors the Android module's method names/signatures so the JS tool layer
 * is platform-agnostic. Rejection messages are model-readable: they feed
 * straight back into the agent loop as corrective tool errors.
 *
 * v1 scope: torch, screen brightness, calendar insert (EventKit),
 * timer/alarm as scheduled local notifications, immediate notifications.
 * (Real Clock-app alarms need AlarmKit entitlements — notification-based
 * timers are the free-provisioning-safe v1.)
 */
@interface MinimusTools : NSObject <RCTBridgeModule>
@end

@implementation MinimusTools

RCT_EXPORT_MODULE(MinimusTools);

+ (BOOL)requiresMainQueueSetup { return NO; }

// ------------------------------------------------------------ diagnostics

/**
 * Release builds don't wire JS console output to the device console, which
 * makes on-device QA blind. This forwards agent diagnostics to the unified
 * log. %{public}@ matters: without it iOS redacts the message to <private>
 * in the syslog relay and remote QA sees nothing but timestamps.
 */
static os_log_t MinimusLog(void)
{
  static os_log_t log;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    log = os_log_create("ai.runanywhere.agent", "agent");
  });
  return log;
}

RCT_EXPORT_METHOD(log:(NSString *)message)
{
  os_log_with_type(MinimusLog(), OS_LOG_TYPE_DEFAULT, "[minimus] %{public}@", message);
}

// ---------------------------------------------------------------- torch

RCT_EXPORT_METHOD(setTorch:(BOOL)on
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  if (device == nil || !device.hasTorch) {
    reject(@"no_flash", @"This device has no flashlight.", nil);
    return;
  }
  NSError *error = nil;
  if (![device lockForConfiguration:&error]) {
    reject(@"torch_failed", @"Could not access the flashlight.", error);
    return;
  }
  if (on) {
    [device setTorchModeOnWithLevel:AVCaptureMaxAvailableTorchLevel error:&error];
  } else {
    device.torchMode = AVCaptureTorchModeOff;
  }
  [device unlockForConfiguration];
  if (error) {
    reject(@"torch_failed", @"Could not switch the flashlight.", error);
  } else {
    resolve(nil);
  }
}

// ----------------------------------------------------------- brightness

RCT_EXPORT_METHOD(setBrightness:(double)level
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    CGFloat clamped = (CGFloat)MAX(0.01, MIN(1.0, level));
    [UIScreen mainScreen].brightness = clamped;
    resolve(nil);
  });
}

// ---------------------------------------------------------- notifications

- (void)withNotificationAuth:(RCTPromiseRejectBlock)reject
                        then:(void (^)(void))work
{
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert |
                                           UNAuthorizationOptionSound |
                                           UNAuthorizationOptionBadge)
                        completionHandler:^(BOOL granted, NSError *_Nullable error) {
    if (!granted) {
      reject(@"no_permission",
             @"Notification permission not granted — ask the user to allow notifications for this app.",
             error);
      return;
    }
    work();
  }];
}

- (void)scheduleNotification:(NSString *)title
                        body:(NSString *_Nullable)body
                     trigger:(UNNotificationTrigger *_Nullable)trigger
                    resolver:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject
{
  [self withNotificationAuth:reject then:^{
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = title;
    if (body.length > 0) content.body = body;
    content.sound = [UNNotificationSound defaultSound];
    NSString *identifier = [NSUUID UUID].UUIDString;
    UNNotificationRequest *request =
        [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:trigger];
    [[UNUserNotificationCenter currentNotificationCenter]
        addNotificationRequest:request
         withCompletionHandler:^(NSError *_Nullable error) {
      if (error) {
        reject(@"notify_failed", @"Could not schedule the notification.", error);
      } else {
        resolve(identifier);
      }
    }];
  }];
}

RCT_EXPORT_METHOD(notify:(NSString *)title
                  body:(NSString *_Nullable)body
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self scheduleNotification:title body:body trigger:nil resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(setTimer:(double)seconds
                  label:(NSString *_Nullable)label
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (seconds < 1) {
    reject(@"bad_timer", @"Timer length must be at least 1 second.", nil);
    return;
  }
  UNTimeIntervalNotificationTrigger *trigger =
      [UNTimeIntervalNotificationTrigger triggerWithTimeInterval:seconds repeats:NO];
  NSString *title = label.length > 0 ? label : @"Timer done";
  [self scheduleNotification:title
                        body:@"Your timer just finished."
                     trigger:trigger
                    resolver:resolve
                    rejecter:reject];
}

RCT_EXPORT_METHOD(setAlarm:(NSInteger)hour
                  minute:(NSInteger)minute
                  label:(NSString *_Nullable)label
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSDateComponents *components = [NSDateComponents new];
  components.hour = hour;
  components.minute = minute;
  UNCalendarNotificationTrigger *trigger =
      [UNCalendarNotificationTrigger triggerWithDateMatchingComponents:components repeats:NO];
  NSString *title = label.length > 0 ? label : @"Alarm";
  [self scheduleNotification:title
                        body:[NSString stringWithFormat:@"It's %02ld:%02ld.", (long)hour, (long)minute]
                     trigger:trigger
                    resolver:resolve
                    rejecter:reject];
}

// ------------------------------------------------------------- calendar

RCT_EXPORT_METHOD(calendarInsert:(NSString *)title
                  startMillis:(double)startMillis
                  durationMinutes:(NSInteger)durationMinutes
                  notes:(NSString *_Nullable)notes
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  EKEventStore *store = [EKEventStore new];
  void (^insert)(void) = ^{
    EKEvent *event = [EKEvent eventWithEventStore:store];
    event.title = title;
    event.startDate = [NSDate dateWithTimeIntervalSince1970:startMillis / 1000.0];
    NSInteger minutes = MAX(5, durationMinutes);
    event.endDate = [event.startDate dateByAddingTimeInterval:minutes * 60.0];
    if (notes.length > 0) event.notes = notes;
    event.calendar = store.defaultCalendarForNewEvents;
    NSError *error = nil;
    if ([store saveEvent:event span:EKSpanThisEvent commit:YES error:&error]) {
      resolve(event.eventIdentifier ?: @"saved");
    } else {
      reject(@"calendar_failed", @"Could not save the event to the calendar.", error);
    }
  };
  [store requestFullAccessToEventsWithCompletion:^(BOOL granted, NSError *_Nullable error) {
    if (!granted) {
      reject(@"no_permission",
             @"Calendar access not granted — ask the user to allow calendar access for this app.",
             error);
      return;
    }
    dispatch_async(dispatch_get_main_queue(), insert);
  }];
}

RCT_EXPORT_METHOD(calendarQuery:(double)startMillis
                  endMillis:(double)endMillis
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  EKEventStore *store = [EKEventStore new];
  [store requestFullAccessToEventsWithCompletion:^(BOOL granted, NSError *_Nullable error) {
    if (!granted) {
      reject(@"no_permission",
             @"Calendar access not granted — ask the user to allow calendar access for this app.",
             error);
      return;
    }
    NSDate *start = [NSDate dateWithTimeIntervalSince1970:startMillis / 1000.0];
    NSDate *end = [NSDate dateWithTimeIntervalSince1970:endMillis / 1000.0];
    NSPredicate *predicate = [store predicateForEventsWithStartDate:start endDate:end calendars:nil];
    NSArray<EKEvent *> *events = [store eventsMatchingPredicate:predicate];
    NSMutableArray *out = [NSMutableArray array];
    for (EKEvent *event in events) {
      [out addObject:@{
        @"title": event.title ?: @"(untitled)",
        @"startMillis": @([event.startDate timeIntervalSince1970] * 1000.0),
        @"endMillis": @([event.endDate timeIntervalSince1970] * 1000.0),
      }];
    }
    resolve(out);
  }];
}

@end
