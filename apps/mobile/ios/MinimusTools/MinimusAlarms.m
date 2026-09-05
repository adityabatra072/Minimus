#import <React/RCTBridgeModule.h>

/**
 * Objective-C export of the Swift MinimusAlarms module. React Native discovers
 * modules through these macros; the implementation lives in MinimusAlarms.swift.
 */
@interface RCT_EXTERN_MODULE(MinimusAlarms, NSObject)

RCT_EXTERN_METHOD(alarmAuthorization:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(alarmSchedule:(nonnull NSNumber *)hour minute:(nonnull NSNumber *)minute label:(NSString *)label repeatsDaily:(BOOL)repeatsDaily resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(timerStart:(nonnull NSNumber *)seconds label:(NSString *)label resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(alarmList:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(alarmCancel:(NSString *)id resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(alarmStop:(NSString *)id resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(alarmPause:(NSString *)id resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(alarmResume:(NSString *)id resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(speakSystem:(NSString *)text rate:(nonnull NSNumber *)rate voiceId:(NSString *)voiceId resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopSystemSpeech:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(systemVoices:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(playAudioFile:(NSString *)path resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopAudio:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(remindersList:(nonnull NSNumber *)withinHours resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup { return NO; }

@end
