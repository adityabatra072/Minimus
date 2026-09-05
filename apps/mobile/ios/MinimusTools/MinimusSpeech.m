#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

/** Objective-C export of the Swift MinimusSpeech event-emitting module. */
@interface RCT_EXTERN_MODULE(MinimusSpeech, RCTEventEmitter)

RCT_EXTERN_METHOD(speechAuthorization:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(speechStart:(NSArray<NSString *> *)contextualStrings onDevice:(BOOL)onDevice recordPath:(NSString *)recordPath resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(speechStop:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(speechCancel:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup { return NO; }

@end
