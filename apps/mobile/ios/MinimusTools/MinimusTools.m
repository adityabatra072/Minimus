#import <React/RCTBridgeModule.h>
#import <AVFoundation/AVFoundation.h>
#import <EventKit/EventKit.h>
#import <UserNotifications/UserNotifications.h>
#import <UIKit/UIKit.h>
#import <Contacts/Contacts.h>
#import <os/log.h>
#import <os/proc.h>
#import <mach/mach.h>

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

// ------------------------------------------------------------- keep awake

/**
 * Hold the screen on while the agent is working.
 *
 * A run is minutes, not milliseconds. During QA an Android device locked
 * mid-beat and the run simply stopped; the only evidence was the battery
 * cooling with no further output. iOS idles out the same way.
 */
RCT_EXPORT_METHOD(setKeepAwake:(BOOL)on
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [UIApplication sharedApplication].idleTimerDisabled = on;
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
      // All-day entries (holidays, birthdays from subscribed calendars) span
      // the whole day — treating them as busy time makes every free gap
      // vanish, and "find me 90 minutes" against zero gaps stalls the model.
      // They don't block time; skip them.
      if (event.isAllDay) continue;
      [out addObject:@{
        @"title": event.title ?: @"(untitled)",
        @"startMillis": @([event.startDate timeIntervalSince1970] * 1000.0),
        @"endMillis": @([event.endDate timeIntervalSince1970] * 1000.0),
      }];
    }
    resolve(out);
  }];
}


// ------------------------------------------------------------- clipboard

RCT_EXPORT_METHOD(clipboardRead:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *text = [UIPasteboard generalPasteboard].string;
    resolve(text ?: @"");
  });
}

RCT_EXPORT_METHOD(clipboardWrite:(NSString *)text
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [UIPasteboard generalPasteboard].string = text ?: @"";
    resolve(nil);
  });
}

// -------------------------------------------------------------- contacts

/**
 * Look a person up by name so "text Sam I'm late" reaches Sam's number
 * instead of an SMS to the literal string "Sam". Returns up to five matches
 * with phone numbers and emails; the model (or the reflex) picks.
 */
RCT_EXPORT_METHOD(contactsSearch:(NSString *)query
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  CNContactStore *store = [CNContactStore new];
  [store requestAccessForEntityType:CNEntityTypeContacts completionHandler:^(BOOL granted, NSError *_Nullable error) {
    if (!granted) {
      reject(@"no_permission",
             @"Contacts access not granted — ask the user to allow contacts for this app.",
             error);
      return;
    }
    NSArray *keys = @[CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey,
                      CNContactPhoneNumbersKey, CNContactEmailAddressesKey];
    NSPredicate *predicate = [CNContact predicateForContactsMatchingName:query];
    NSError *fetchError = nil;
    NSArray<CNContact *> *contacts = [store unifiedContactsMatchingPredicate:predicate
                                                                keysToFetch:keys
                                                                      error:&fetchError];
    if (fetchError) {
      reject(@"contacts_failed", @"Could not search contacts.", fetchError);
      return;
    }
    NSMutableArray *out = [NSMutableArray array];
    for (CNContact *c in contacts) {
      if (out.count >= 5) break;
      NSMutableArray *phones = [NSMutableArray array];
      for (CNLabeledValue<CNPhoneNumber *> *pn in c.phoneNumbers) {
        [phones addObject:@{
          @"label": [CNLabeledValue localizedStringForLabel:pn.label ?: @""] ?: @"",
          @"number": pn.value.stringValue ?: @"",
        }];
      }
      NSMutableArray *emails = [NSMutableArray array];
      for (CNLabeledValue<NSString *> *em in c.emailAddresses) {
        [emails addObject:em.value ?: @""];
      }
      NSString *name = [[NSString stringWithFormat:@"%@ %@", c.givenName ?: @"", c.familyName ?: @""]
                        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
      [out addObject:@{
        @"name": name,
        @"nickname": c.nickname ?: @"",
        @"phones": phones,
        @"emails": emails,
      }];
    }
    resolve(out);
  }];
}

// -------------------------------------------------------------- reminders

/**
 * A real entry in the Reminders app (EventKit), with an optional due time.
 * Better than a notification for anything the user wants to tick off later.
 */
RCT_EXPORT_METHOD(reminderCreate:(NSString *)title
                  dueMillis:(double)dueMillis
                  notes:(NSString *_Nullable)notes
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  EKEventStore *store = [EKEventStore new];
  void (^insert)(void) = ^{
    EKReminder *reminder = [EKReminder reminderWithEventStore:store];
    reminder.title = title;
    if (notes.length > 0) reminder.notes = notes;
    reminder.calendar = store.defaultCalendarForNewReminders;
    if (dueMillis > 0) {
      NSDate *due = [NSDate dateWithTimeIntervalSince1970:dueMillis / 1000.0];
      NSCalendar *cal = [NSCalendar currentCalendar];
      reminder.dueDateComponents = [cal components:(NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay |
                                                    NSCalendarUnitHour | NSCalendarUnitMinute)
                                          fromDate:due];
      [reminder addAlarm:[EKAlarm alarmWithAbsoluteDate:due]];
    }
    NSError *error = nil;
    if ([store saveReminder:reminder commit:YES error:&error]) {
      resolve(reminder.calendarItemIdentifier ?: @"saved");
    } else {
      reject(@"reminder_failed", @"Could not save the reminder.", error);
    }
  };
  [store requestFullAccessToRemindersWithCompletion:^(BOOL granted, NSError *_Nullable error) {
    if (!granted) {
      reject(@"no_permission",
             @"Reminders access not granted — ask the user to allow reminders for this app.",
             error);
      return;
    }
    dispatch_async(dispatch_get_main_queue(), insert);
  }];
}

// -------------------------------------------------- notification at a time

/**
 * A local notification at an absolute time. Scheduled agent runs use it so a
 * task that comes due while the app is suspended still reaches the user; the
 * tap reopens the app, which runs anything overdue.
 */
RCT_EXPORT_METHOD(notifyAt:(double)atMillis
                  title:(NSString *)title
                  body:(NSString *_Nullable)body
                  identifier:(NSString *_Nullable)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSTimeInterval seconds = atMillis / 1000.0 - [[NSDate date] timeIntervalSince1970];
  if (seconds < 1) seconds = 1;
  UNTimeIntervalNotificationTrigger *trigger =
      [UNTimeIntervalNotificationTrigger triggerWithTimeInterval:seconds repeats:NO];
  [self withNotificationAuth:reject then:^{
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = title;
    if (body.length > 0) content.body = body;
    content.sound = [UNNotificationSound defaultSound];
    NSString *ident = identifier.length > 0 ? identifier : [NSUUID UUID].UUIDString;
    UNNotificationRequest *request =
        [UNNotificationRequest requestWithIdentifier:ident content:content trigger:trigger];
    [[UNUserNotificationCenter currentNotificationCenter]
        addNotificationRequest:request
         withCompletionHandler:^(NSError *_Nullable error) {
      if (error) reject(@"notify_failed", @"Could not schedule the notification.", error);
      else resolve(ident);
    }];
  }];
}

RCT_EXPORT_METHOD(cancelNotification:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [[UNUserNotificationCenter currentNotificationCenter]
      removePendingNotificationRequestsWithIdentifiers:@[identifier ?: @""]];
  resolve(nil);
}


// ------------------------------------------------------------ device health

/**
 * Thermal state and the app's memory footprint. A 2.6B model on the GPU is
 * fast until the phone gets hot; with the torch on at full power a run went
 * from 24 to 4 tokens per second in three minutes. Surfacing the thermal
 * state next to the speed numbers is what turns "it got slow" into a cause.
 */
RCT_EXPORT_METHOD(deviceHealth:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSProcessInfoThermalState thermal = [NSProcessInfo processInfo].thermalState;
  NSString *label = thermal == NSProcessInfoThermalStateNominal ? @"nominal"
                  : thermal == NSProcessInfoThermalStateFair ? @"fair"
                  : thermal == NSProcessInfoThermalStateSerious ? @"serious" : @"critical";
  task_vm_info_data_t info;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  kern_return_t kr = task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count);
  double footprint = kr == KERN_SUCCESS ? (double)info.phys_footprint : -1;
  resolve(@{
    @"thermal": label,
    @"lowPowerMode": @([NSProcessInfo processInfo].isLowPowerModeEnabled),
    @"footprintBytes": @(footprint),
    @"availableBytes": @((double)os_proc_available_memory()),
  });
}


/**
 * Ask for notification permission at a moment the user expects a prompt
 * (onboarding), not in the middle of an agent run. Device evidence: a taught
 * phrase whose step set an alarm sat for three minutes on the permission
 * dialog while the run waited.
 */
RCT_EXPORT_METHOD(requestNotificationPermission:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                    completionHandler:^(BOOL granted, NSError *_Nullable error) {
    resolve(@(granted));
  }];
}

@end
