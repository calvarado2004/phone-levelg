import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const gradleWrapper = readFileSync("apps/mobile/android/gradle/wrapper/gradle-wrapper.properties", "utf8");
const settingsGradle = readFileSync("apps/mobile/android/settings.gradle", "utf8");
const appBuildGradle = readFileSync("apps/mobile/android/app/build.gradle", "utf8");
const podfile = readFileSync("apps/mobile/ios/Podfile", "utf8");
const infoPlist = readFileSync("apps/mobile/ios/PhoneLevelG/Info.plist", "utf8");
const appJson = readFileSync("apps/mobile/app.json", "utf8");
const mobilePackage = readFileSync("apps/mobile/package.json", "utf8");
const appTsx = readFileSync("apps/mobile/App.tsx", "utf8");
const adaptiveIcon = readFileSync("apps/mobile/android/app/src/main/res/drawable/ic_launcher_foreground.xml", "utf8");
const androidIcon = readFileSync("apps/mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", "utf8");

assert.match(gradleWrapper, /gradle-8\.14\.3-bin\.zip/, "Android Gradle wrapper must stay on a React Native compatible Gradle version");
assert.match(settingsGradle, /NODE_BINARY/, "settings.gradle must support NODE_BINARY for Android Studio GUI launches");
assert.match(appBuildGradle, /NODE_BINARY/, "app/build.gradle must support NODE_BINARY for Android Studio GUI launches");
assert.match(appBuildGradle, /applicationId 'io\.levelg\.phone'/, "Android package id must stay stable");
assert.match(podfile, /use_expo_modules!/, "iOS Podfile must include Expo modules");
assert.match(infoPlist, /NSCameraUsageDescription/, "iOS must declare camera usage for video calls");
assert.match(infoPlist, /NSMicrophoneUsageDescription/, "iOS must declare microphone usage for calls");
assert.match(appTsx, /registerGlobals\(\)/, "LiveKit WebRTC globals must be registered before calls");
assert.match(appTsx, /StatusBar as NativeStatusBar/, "Android layout must read native status bar height");
assert.match(appTsx, /paddingTop: 10 \+ ANDROID_STATUS_BAR_HEIGHT/, "Android header must reserve status bar space so call buttons are tappable");
assert.match(appTsx, /from "expo-audio"/, "Incoming calls must use the compatible Expo audio module for ringtone playback");
assert.match(appTsx, /directRoomID/, "Mobile app must support deterministic 1-1 direct message rooms");
assert.match(appTsx, /`dm:\$\{\[firstID, secondID\]\.sort\(\)\.join\(":\"\)\}`/, "1-1 rooms must use explicit private room IDs");
assert.match(appTsx, /rooms\/\$\{encodeURIComponent\(roomID\)\}\/messages\?userId=\$\{encodeURIComponent\(userID\)\}/, "Private message history requests must include the current user id");
assert.match(appTsx, /direct\/inbox\?userId=\$\{encodeURIComponent\(session\.userId\)\}/, "Mobile app must poll direct inbox so first private messages are not lost");
assert.match(appTsx, /messagesEqual\(current, nextMessages\) \? current : nextMessages/, "Message refresh polling must not rewrite equivalent state on every tick");
assert.match(appTsx, /membersEqual\(current, nextMembers\) \? current : nextMembers/, "Member refresh polling must not rewrite equivalent state on every tick");
assert.match(appTsx, /stringArraysEqual\(current, nextUnreadRooms\) \? current : nextUnreadRooms/, "Unread polling must not rewrite equivalent state on every tick");
assert.match(appTsx, /method: "POST"[\s\S]*senderId: session\.userId[\s\S]*setDraft\(""\)/, "Composer must persist messages over HTTP before clearing the draft");
assert.doesNotMatch(appTsx, /sendSocket\("message:send"/, "Composer must not depend on websocket-only message persistence");
assert.match(appTsx, /requestCallPermissions\(mode\)/, "Call permissions must match voice or video mode");
assert.match(appTsx, /setCallActive\(true\);\s*setCallStatus\("Connecting"\);/s, "Call taps must immediately show connecting state");
assert.match(appTsx, /accessibilityLabel=\{`Start voice call in \$\{activeRoomTitle\}`\}/, "Voice call button must be an accessible explicit Android tap target");
assert.match(appTsx, /onPress=\{\(\) => void joinCall\("voice"\)\}/, "Voice call button must invoke the call path directly");
assert.match(appTsx, /onPress=\{\(\) => void joinCall\("video"\)\}/, "Video call button must invoke the call path directly");
assert.match(appTsx, /hitSlop=\{12\}/, "Call buttons must have enlarged mobile tap targets");
assert.match(appTsx, /setIncomingCall\(\{ roomId: payload\.data\.roomId, sender: payload\.data\.sender, mode: ringMode \}\)/, "Incoming calls must render a call UI with the ringing room");
assert.match(appTsx, /joinCall\(nextCall\.mode, nextCall\.roomId, false\)/, "Accepting an incoming call must join the room that actually rang");
assert.match(appTsx, /createAudioPlayer\(require\("\.\/assets\/incoming-call\.wav"\)/, "Incoming calls must play the bundled ringtone");
assert.match(appTsx, /player\.loop = true/, "Incoming call ringtone must loop until accepted or declined");
assert.match(appTsx, /Vibration\.vibrate\(\[0, 750, 350\], true\)/, "Incoming calls must vibrate until accepted or declined");
assert.match(appJson, /"icon": "\.\/assets\/icon\.png"/, "Expo must have a real app icon source");
assert.match(appJson, /"adaptiveIcon"/, "Android must have adaptive icon config");
assert.match(mobilePackage, /EXPO_PUBLIC_LIVEKIT_URL=ws:\/\/192\.168\.1\.88:7880/, "OpenShift mobile builds must use the Fedora host LiveKit forwarder");
assert.doesNotMatch(mobilePackage, /openshift[^"]*EXPO_PUBLIC_LIVEKIT_URL=ws:\/\/localhost:7880/, "OpenShift mobile builds must not point LiveKit at localhost");
assert.match(androidIcon, /@mipmap\/ic_launcher_foreground/, "Android adaptive icon must use the pasted phone artwork");
assert.match(adaptiveIcon, /#7C3AED/, "Fallback Android adaptive vector must use purple phone artwork");
assert.ok(existsSync("apps/mobile/assets/icon.png"), "mobile app icon PNG must exist");
assert.ok(existsSync("apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.webp"), "Android adaptive foreground PNG must exist");
assert.ok(
  existsSync("apps/mobile/ios/PhoneLevelG/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png"),
  "iOS app icon PNG must exist",
);

console.log("Validated native Android and iOS project assets");
