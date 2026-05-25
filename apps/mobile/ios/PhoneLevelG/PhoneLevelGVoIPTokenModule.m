#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface PhoneLevelGVoIPTokenModule : RCTEventEmitter <RCTBridgeModule>
@end

@implementation PhoneLevelGVoIPTokenModule

RCT_EXPORT_MODULE(PhoneLevelGVoIPToken)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if (self = [super init]) {
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(voipTokenUpdated:)
                                                 name:@"PhoneLevelGVoIPTokenUpdated"
                                               object:nil];
  }
  return self;
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[@"PhoneLevelGVoIPTokenUpdated"];
}

- (void)voipTokenUpdated:(NSNotification *)notification
{
  NSString *token = notification.userInfo[@"token"] ?: @"";
  [self sendEventWithName:@"PhoneLevelGVoIPTokenUpdated" body:@{@"token": token}];
}

RCT_EXPORT_METHOD(getToken:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *token = [[NSUserDefaults standardUserDefaults] stringForKey:@"phone-levelg.apnsVoipToken"] ?: @"";
  resolve(token);
}

@end
