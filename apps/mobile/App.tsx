import "react-native-get-random-values";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import * as AuthSession from "expo-auth-session";
import * as DocumentPicker from "expo-document-picker";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import * as Notifications from "expo-notifications";
import * as Sharing from "expo-sharing";
import * as WebBrowser from "expo-web-browser";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  LogBox,
  Modal,
  NativeEventEmitter,
  NativeModules,
  Platform,
  PermissionsAndroid,
  Pressable,
  StyleSheet,
  StatusBar as NativeStatusBar,
  type StyleProp,
  Text,
  TextInput,
  type TextStyle,
  Vibration,
  View
} from "react-native";
import { LogLevel, Room, RoomEvent, Track, isVideoTrack, setLogLevel, type VideoTrack as LiveKitVideoTrack } from "livekit-client";
import {
  Phone,
  PhoneOff,
  Bell,
  Camera,
  FileText,
  Image as ImageIcon,
  LogOut,
  Mic,
  Paperclip,
  SendHorizontal,
  Mail,
  Settings,
  Smile,
  SwitchCamera,
  Trash2,
  Users,
  Video
} from "lucide-react-native";

WebBrowser.maybeCompleteAuthSession();
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true
  })
});
setLogLevel(LogLevel.silent);
LogBox.ignoreLogs(["could not determine track dimensions"]);

declare const process: {
  env: Record<string, string | undefined>;
};
declare const require: (moduleName: string) => any;

const nacl = require("tweetnacl") as {
  randomBytes: (length: number) => Uint8Array;
  secretbox: ((message: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Uint8Array) & {
    open: (box: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Uint8Array | null;
    nonceLength: number;
  };
};
const naclUtil = require("tweetnacl-util") as {
  decodeBase64: (value: string) => Uint8Array;
  encodeBase64: (value: Uint8Array) => string;
  decodeUTF8: (value: string) => Uint8Array;
  encodeUTF8: (value: Uint8Array) => string;
};

const NativeRTCView = Platform.OS === "web"
  ? undefined
  : (require("@livekit/react-native-webrtc") as { RTCView: ComponentType<any> }).RTCView;
const registerLiveKitGlobals = Platform.OS === "web"
  ? undefined
  : (require("@livekit/react-native") as { registerGlobals: () => void }).registerGlobals;
let cachedNativeCallKeep: any | null | undefined;
const nativeVoIPTokenModule: { getToken?: () => Promise<string> } | undefined =
  Platform.OS === "ios" ? NativeModules.PhoneLevelGVoIPToken : undefined;

function getNativeCallKeep() {
  if (Platform.OS !== "ios") return undefined;
  if (cachedNativeCallKeep !== undefined) return cachedNativeCallKeep ?? undefined;
  try {
    cachedNativeCallKeep = require("react-native-callkeep").default;
  } catch {
    cachedNativeCallKeep = null;
  }
  return cachedNativeCallKeep ?? undefined;
}

registerLiveKitGlobals?.();

const OPENSHIFT_API_URL = "https://phone-levelg-server-phone-levelg.apps.ocp-think.levelg.io";
const DEFAULT_API_URL = process.env.EXPO_PUBLIC_API_URL ?? OPENSHIFT_API_URL;
const DEFAULT_LIVEKIT_URL = Platform.OS === "web" ? "ws://localhost:7880" : "ws://192.168.1.88:7880";
const LIVEKIT_URL = process.env.EXPO_PUBLIC_LIVEKIT_URL ?? DEFAULT_LIVEKIT_URL;
const GOOGLE_ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const GOOGLE_CLIENT_ID =
  Platform.OS === "ios"
    ? GOOGLE_IOS_CLIENT_ID
    : Platform.OS === "android"
      ? GOOGLE_ANDROID_CLIENT_ID
      : GOOGLE_WEB_CLIENT_ID;
const GOOGLE_DISCOVERY = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  userInfoEndpoint: "https://www.googleapis.com/oauth2/v3/userinfo"
};
const ROOM_ID = "home";
const E2E_MODE = process.env.EXPO_PUBLIC_E2E_MODE === "1";
const STORED_SESSION_KEY = "phone-levelg.session.v4";
const STORED_DEVICE_ID_KEY = "phone-levelg.device.v1";
const STORED_PENDING_CALL_KEY = "phone-levelg.pendingCall.v1";
const STORED_PRIVATE_MESSAGE_SOUND_KEY = "phone-levelg.privateMessageSound.v1";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CALL_RING_TIMEOUT_MS = 45 * 1000;
const INCOMING_CALL_CHANNEL_ID = "incoming-calls";
const PRIVATE_MESSAGE_CHANNEL_ID = "private-messages";
const DEFAULT_RINGTONE_SOUND = "rockstar.mp3";
const PRIVATE_MESSAGE_SOUND = Platform.OS === "android" ? "message_notification.mp3" : "message-notification.mp3";
const ENCRYPTED_MESSAGE_PREFIX = "plgenc:v1:";
const ATTACHMENT_MESSAGE_PREFIX = "plgattach:v1:";
const ENCRYPTED_MESSAGE_UNAVAILABLE = "Encrypted message unavailable";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ANDROID_STATUS_BAR_HEIGHT = Platform.OS === "android" ? NativeStatusBar.currentHeight ?? 0 : 0;
const IOS_STATUS_BAR_HEIGHT = Platform.OS === "ios" ? 44 : 0;
const TOP_SAFE_AREA_HEIGHT = ANDROID_STATUS_BAR_HEIGHT + IOS_STATUS_BAR_HEIGHT;

type Session = {
  userId: string;
  displayName: string;
  accountEmail: string;
  avatarURL?: string;
  messageKeySecret: string;
};

type StoredSession = {
  session: Session;
  serverURL: string;
  inviteCode: string;
  expiresAt: number;
};

type GoogleUserInfo = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

type Message = {
  id: string;
  roomId: string;
  senderId: string;
  sender: string;
  text: string;
  attachment?: MessageAttachment;
  createdAt: string;
};

type MessageAttachment = {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  nonce: string;
};

type AttachmentUpload = {
  uri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64?: string;
};

type Member = {
  id: string;
  displayName: string;
  avatarURL?: string;
  createdAt?: string;
  lastSeenAt: string;
  lastReachableAt?: string;
  reachable?: boolean;
};

type IncomingCall = {
  callUUID: string;
  callId: string;
  roomId: string;
  senderId: string;
  sender: string;
  mode: "voice" | "video";
  expiresAt?: string;
};

type IncomingCallPayload = {
  callId: string;
  roomId: string;
  senderId: string;
  sender: string;
  mode: "voice" | "video";
  expiresAt?: string;
};

type NativeCallKeepIncomingCallEvent = {
  callUUID?: string;
  fromPushKit?: string;
  payload?: unknown;
};

type NativeCallKeepDelayedEvent = {
  name?: string;
  data?: NativeCallKeepIncomingCallEvent;
};

type CallPeer = {
  displayName: string;
  avatarURL?: string;
};

type PermissionState = "unknown" | "granted" | "denied";

type SocketEvent =
  | { type: "message:new"; data: Message }
  | { type: "message:clear"; data: { roomId: string; senderId: string } }
  | { type: "call:ring"; data: { callId?: string; roomId: string; senderId: string; sender: string; mode?: "voice" | "video"; expiresAt?: string } }
  | { type: "call:end"; data: { callId?: string; roomId: string; senderId: string; sender: string; reason?: string } }
  | { type: "call:reject"; data: { callId?: string; roomId: string; senderId: string; sender: string; reason?: string } }
  | { type: "member:joined"; data: Member };

const QUICK_EMOJIS = ["👍", "😂", "❤️", "🔥", "🎉", "👀"];
const CAT_MEMES = [
  { label: "loaf", text: "cat loaf has joined the chat 🐱🍞" },
  { label: "zoomies", text: "midnight zoomies are now in progress 🐈💨" },
  { label: "judge", text: "the cat is judging this message 😼" },
  { label: "nap", text: "brb, professional cat nap mode 🐾" }
];

export default function App() {
  const e2eScreen = getQueryParam("screen");
  const googleRedirectURI = AuthSession.makeRedirectUri({ scheme: "phonelevelg", path: "oauthredirect" });
  const [googleRequest, googleResponse, promptGoogleSignIn] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID ?? "missing-google-client-id",
      redirectUri: googleRedirectURI,
      responseType: AuthSession.ResponseType.Code,
      scopes: ["openid", "profile", "email"],
      extraParams: { prompt: "select_account" }
    },
    GOOGLE_DISCOVERY
  );
  const [session, setSession] = useState<Session | null>(
    E2E_MODE && e2eScreen !== "login"
      ? { userId: "e2e-user", displayName: "Carlos", accountEmail: "carlos@example.test", messageKeySecret: "e2e-message-key-secret" }
      : null
  );
  const [displayName, setDisplayName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [avatarURL, setAvatarURL] = useState("");
  const [googleAccessToken, setGoogleAccessToken] = useState("");
  const [serverURL, setServerURL] = useState(DEFAULT_API_URL);
  const [inviteCode, setInviteCode] = useState("home");
  const [messages, setMessages] = useState<Message[]>(() => E2E_MODE && e2eScreen !== "login" ? [
    {
      id: "m1",
      roomId: ROOM_ID,
      senderId: "ana",
      sender: "Ana",
      text: "Dinner is ready in 10 👍",
      createdAt: "2026-05-23T14:00:00Z"
    },
    {
      id: "m2",
      roomId: ROOM_ID,
      senderId: "e2e-user",
      sender: "Carlos",
      text: "On my way 🎉",
      createdAt: "2026-05-23T14:01:00Z"
    }
  ] : []);
  const [members, setMembers] = useState<Member[]>(() => E2E_MODE && e2eScreen !== "login" ? [
    { id: "e2e-user", displayName: "Carlos", lastSeenAt: "2026-05-23T14:01:00Z" },
    { id: "ana", displayName: "Ana", lastSeenAt: "2026-05-23T14:00:00Z" }
  ] : []);
  const [draft, setDraft] = useState("");
  const [sendingAttachment, setSendingAttachment] = useState(false);
  const [privateMessageSoundEnabled, setPrivateMessageSoundEnabled] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [catMemesOpen, setCatMemesOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState("Ready");
  const [remoteParticipantCount, setRemoteParticipantCount] = useState(0);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [unreadRoomIDs, setUnreadRoomIDs] = useState<string[]>([]);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(() => E2E_MODE && e2eScreen === "incoming" ? {
    callUUID: createCallUUID(),
    callId: "e2e-incoming-call",
    roomId: directRoomID("ana", "e2e-user"),
    senderId: "ana",
    sender: "Ana",
    mode: "video",
    expiresAt: new Date(Date.now() + CALL_RING_TIMEOUT_MS).toISOString()
  } : null);
  const [callMode, setCallMode] = useState<"voice" | "video">("voice");
  const [callPeer, setCallPeer] = useState<CallPeer | null>(null);
  const [localVideoTrack, setLocalVideoTrack] = useState<LiveKitVideoTrack | undefined>();
  const [remoteVideoTrack, setRemoteVideoTrack] = useState<LiveKitVideoTrack | undefined>();
  const [cameraFacingMode, setCameraFacingMode] = useState<"user" | "environment">("user");
  const [iosCallAlertPermission, setIOSCallAlertPermission] = useState<PermissionState>("unknown");
  const [iosMicPermission, setIOSMicPermission] = useState<PermissionState>("unknown");
  const [iosCameraPermission, setIOSCameraPermission] = useState<PermissionState>("unknown");
  const [nativeCallEventTick, setNativeCallEventTick] = useState(0);
  const [attachmentPreviewURIs, setAttachmentPreviewURIs] = useState<Record<string, string>>({});
  const socketRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<Room | null>(null);
  const activeCallRoomIDRef = useRef<string | null>(null);
  const activeCallIDRef = useRef<string | null>(null);
  const activeCallUUIDRef = useRef<string | null>(null);
  const incomingCallRef = useRef<IncomingCall | null>(null);
  const nativeCallsRef = useRef<Record<string, IncomingCall>>({});
  const handledCallIDsRef = useRef<Set<string>>(new Set());
  const notifiedPrivateMessageIDsRef = useRef<Set<string>>(new Set());
  const privateMessageSoundEnabledRef = useRef(true);
  const loadingAttachmentPreviewIDsRef = useRef<Set<string>>(new Set());
  const incomingCallExpirationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outgoingCallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callKeepReadyRef = useRef(false);
  const incomingCallNotificationRef = useRef<string | null>(null);
  const pendingNativeAcceptCallUUIDRef = useRef<string | null>(null);
  const pendingNativeEndCallUUIDRef = useRef<string | null>(null);
  const pendingNativeAcceptRef = useRef<IncomingCallPayload | null>(null);
  const pendingNativeDeclineRef = useRef<IncomingCallPayload | null>(null);
  const apiURL = useMemo(() => normalizeServerURL(serverURL), [serverURL]);
  const googleAuthConfigured = Boolean(GOOGLE_CLIENT_ID);
  const googleSignInReady = googleAuthConfigured && (Platform.OS === "web" ? Boolean(googleRequest) : true);

  const activeRoomID = useMemo(() => {
    if (!session || !selectedMember) return ROOM_ID;
    return directRoomID(session.userId, selectedMember.id);
  }, [selectedMember, session]);
  const activeRoomTitle = selectedMember?.displayName ?? "Home";
  const headerTitle = session ? `${activeRoomTitle} - ${session.displayName}` : activeRoomTitle;
  const canSend = useMemo(() => draft.trim().length > 0 && session, [draft, session]);
  const canSendAttachment = Boolean(session && selectedMember && !sendingAttachment);
  const callPeerName = callPeer?.displayName ?? activeRoomTitle;
  const isFullScreenCall = callActive;
  const selfReachable = session ? members.find(member => member.id === session.userId)?.reachable !== false : false;
  const connectionStatus = connected ? callStatus : selfReachable ? "Ready" : "Offline";

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    privateMessageSoundEnabledRef.current = privateMessageSoundEnabled;
  }, [privateMessageSoundEnabled]);

  useEffect(() => {
    if (!session) {
      loadingAttachmentPreviewIDsRef.current.clear();
      setAttachmentPreviewURIs({});
      return;
    }
    messages
      .filter(message => message.attachment?.mimeType.startsWith("image/"))
      .forEach(message => {
        void loadAttachmentPreview(message);
      });
  }, [messages, session]);

  useEffect(() => {
    if (Platform.OS === "web" || !GOOGLE_WEB_CLIENT_ID) return;
    GoogleSignin.configure({
      webClientId: GOOGLE_WEB_CLIENT_ID,
      iosClientId: GOOGLE_IOS_CLIENT_ID,
      scopes: ["openid", "profile", "email"]
    });
  }, []);

  useEffect(() => {
    if (E2E_MODE) return;
    void restoreStoredSession();
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android" || E2E_MODE) return;
    const handleURL = (url: string | null) => {
      const nativeCall = parseNativeCallURL(url);
      if (nativeCall?.action === "accept") {
        void acceptNativeIncomingCallPayload(nativeCall.payload);
      } else if (nativeCall?.action === "decline") {
        void declineNativeIncomingCallPayload(nativeCall.payload);
      }
    };
    void Linking.getInitialURL().then(handleURL).catch(() => undefined);
    const subscription = Linking.addEventListener("url", event => handleURL(event.url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!session || !pendingNativeAcceptRef.current) return;
    const payload = pendingNativeAcceptRef.current;
    pendingNativeAcceptRef.current = null;
    void acceptNativeIncomingCallPayload(payload);
  }, [session]);

  useEffect(() => {
    if (pendingNativeEndCallUUIDRef.current) {
      const callUUID = pendingNativeEndCallUUIDRef.current;
      pendingNativeEndCallUUIDRef.current = null;
      void endNativeCall(callUUID);
      return;
    }

    const callUUID = pendingNativeAcceptCallUUIDRef.current;
    if (!session || !callUUID || !nativeCallsRef.current[callUUID]) return;
    pendingNativeAcceptCallUUIDRef.current = null;
    void acceptNativeIncomingCall(callUUID);
  }, [nativeCallEventTick, session]);

  useEffect(() => {
    if (!session || !connected || !pendingNativeDeclineRef.current) return;
    const payload = pendingNativeDeclineRef.current;
    pendingNativeDeclineRef.current = null;
    void declineNativeIncomingCallPayload(payload);
  }, [connected, session]);

  useEffect(() => {
    if (!session || E2E_MODE || !supportsNativePushRegistration()) return;
    const subscription = Notifications.addPushTokenListener(() => {
      void registerDeviceForPush(session, apiURL);
    });
    return () => subscription.remove();
  }, [apiURL, session]);

  useEffect(() => {
    if (!session || Platform.OS !== "ios" || E2E_MODE) return;
    void refreshIOSCallPermissions();
  }, [session]);

  useEffect(() => {
    if (!session || Platform.OS !== "ios" || E2E_MODE || !nativeVoIPTokenModule) return;
    const emitter = new NativeEventEmitter(nativeVoIPTokenModule as any);
    const subscription = emitter.addListener("PhoneLevelGVoIPTokenUpdated", () => {
      void registerDeviceForPush(session, apiURL);
    });
    return () => subscription.remove();
  }, [apiURL, session]);

  useEffect(() => {
    if (!session || E2E_MODE || !supportsNativePushRegistration()) return;
    const receivedSubscription = Notifications.addNotificationReceivedListener(notification => {
      void showIncomingCallFromPayload(notification.request.content.data, "native-push");
    });
    const responseSubscription = Notifications.addNotificationResponseReceivedListener(response => {
      void showIncomingCallFromPayload(response.notification.request.content.data, "native-push");
    });
    return () => {
      receivedSubscription.remove();
      responseSubscription.remove();
    };
  }, [session]);

  useEffect(() => {
    const nativeCallKeep = getNativeCallKeep();
    if (E2E_MODE || !nativeCallKeep) return;
    const listeners = [
      nativeCallKeep.addEventListener("answerCall", ({ callUUID }: { callUUID: string }) => {
        queueNativeAnswerCall(callUUID);
      }),
      nativeCallKeep.addEventListener("endCall", ({ callUUID }: { callUUID: string }) => {
        queueNativeEndCall(callUUID);
      }),
      nativeCallKeep.addEventListener("didDisplayIncomingCall", (event: NativeCallKeepIncomingCallEvent) => {
        trackNativeCallKeepIncomingCall(event);
      }),
      nativeCallKeep.addEventListener("didLoadWithEvents", (events: NativeCallKeepDelayedEvent[]) => {
        events.forEach(event => {
          if (event.name === "RNCallKeepDidDisplayIncomingCall" && event.data) {
            trackNativeCallKeepIncomingCall(event.data);
          }
          if (event.name === "RNCallKeepPerformAnswerCallAction" && event.data?.callUUID) {
            queueNativeAnswerCall(event.data.callUUID);
          }
          if (event.name === "RNCallKeepPerformEndCallAction" && event.data?.callUUID) {
            queueNativeEndCall(event.data.callUUID);
          }
        });
      }),
      nativeCallKeep.addEventListener("didActivateAudioSession", () => {
        void setIsAudioActiveAsync(true);
      })
    ];

    void setupNativeCallUI();

    return () => {
      listeners.forEach(listener => listener.remove());
      nativeCallKeep.endAllCalls?.();
      callKeepReadyRef.current = false;
    };
  }, []);

  async function setupNativeCallUI() {
    const nativeCallKeep = getNativeCallKeep();
    if (!nativeCallKeep || callKeepReadyRef.current) return;

    try {
      const accepted = await nativeCallKeep.setup({
        ios: {
          appName: "Phone LevelG",
          supportsVideo: true,
          includesCallsInRecents: false
        },
        android: {
          alertTitle: "Phone LevelG calls",
          alertDescription: "Allow Phone LevelG to show native incoming call screens.",
          cancelButton: "Cancel",
          okButton: "Allow",
          imageName: "ic_launcher",
          additionalPermissions: [PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE],
          selfManaged: false,
          foregroundService: {
            channelId: "phone-levelg-calls",
            channelName: "Phone LevelG calls",
            notificationTitle: "Phone LevelG call active",
            notificationIcon: "ic_launcher"
          }
        }
      });
      callKeepReadyRef.current = accepted !== false;
      if (Platform.OS === "android") {
        nativeCallKeep.setAvailable(true);
      }
    } catch {
      callKeepReadyRef.current = false;
    }
  }

  async function refreshIOSCallPermissions() {
    if (Platform.OS !== "ios") return;

    const notificationPermission = await Notifications.getPermissionsAsync().catch(() => null);
    if (notificationPermission) {
      setIOSCallAlertPermission(notificationPermission.granted ? "granted" : notificationPermission.canAskAgain === false ? "denied" : "unknown");
    }

    const micPermission = await getRecordingPermissionsAsync().catch(() => null);
    if (micPermission) {
      setIOSMicPermission(micPermission.granted ? "granted" : micPermission.canAskAgain === false ? "denied" : "unknown");
    }
  }

  async function requestIPhoneCallAlertPermission() {
    if (Platform.OS !== "ios") return;
    const permission = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowSound: true,
        allowBadge: true
      }
    });
    setIOSCallAlertPermission(permission.granted ? "granted" : "denied");
    if (!permission.granted && permission.canAskAgain === false) {
      await Linking.openSettings().catch(() => undefined);
    }
    if (session) {
      void registerDeviceForPush(session, apiURL);
    }
  }

  async function requestIPhoneMicPermission() {
    if (Platform.OS !== "ios") return;
    const permission = await requestRecordingPermissionsAsync();
    setIOSMicPermission(permission.granted ? "granted" : "denied");
    if (!permission.granted && permission.canAskAgain === false) {
      await Linking.openSettings().catch(() => undefined);
    }
  }

  async function requestIPhoneCameraPermission() {
    if (Platform.OS !== "ios") return;
    const granted = await requestIOSCameraPermission();
    setIOSCameraPermission(granted ? "granted" : "denied");
    if (!granted) {
      await Linking.openSettings().catch(() => undefined);
    }
  }

  async function requestIPhoneCallPermissions() {
    if (Platform.OS !== "ios") return;
    await requestIPhoneCallAlertPermission();
    await requestIPhoneMicPermission();
    await requestIPhoneCameraPermission();
    await refreshIOSCallPermissions();
  }

  async function displayNativeIncomingCall(call: IncomingCall) {
    const nativeCallKeep = getNativeCallKeep();
    if (!nativeCallKeep) return;

    await setupNativeCallUI();
    if (!callKeepReadyRef.current) return;

    try {
      nativeCallKeep.displayIncomingCall(
        call.callUUID,
        call.roomId,
        call.sender,
        "generic",
        call.mode === "video",
        { supportsHolding: false, supportsGrouping: false }
      );
    } catch {
      // CallKit is the single iOS incoming-call surface; failures are logged by native tooling.
    }
  }

  async function showIncomingCallFromPayload(data: unknown, source: "websocket" | "native-push") {
    if (!session) return;
    const payload = normalizeIncomingCallPayload(data);
    if (!payload || payload.senderId === session.userId || isExpiredCall(payload.expiresAt)) return;
    if (handledCallIDsRef.current.has(payload.callId) || incomingCallRef.current?.callId === payload.callId || activeCallRoomIDRef.current === payload.roomId) {
      return;
    }

    handledCallIDsRef.current.add(payload.callId);
    const nextCall: IncomingCall = {
      callUUID: createCallUUID(),
      callId: payload.callId,
      roomId: payload.roomId,
      senderId: payload.senderId,
      sender: payload.sender,
      mode: payload.mode,
      expiresAt: payload.expiresAt
    };
    nativeCallsRef.current[nextCall.callUUID] = nextCall;
    setCallPeer({ displayName: nextCall.sender });
    await AsyncStorage.setItem(STORED_PENDING_CALL_KEY, JSON.stringify(nextCall)).catch(() => undefined);
    scheduleIncomingCallExpiration(nextCall);
    void displayNativeIncomingCall(nextCall);
    if (Platform.OS === "ios") {
      if (source === "native-push") {
        void refreshMembers();
      }
      return;
    }

    setIncomingCall(nextCall);
    void startIncomingCallTone();

    if (source === "native-push") {
      void refreshMembers();
    }
  }

  async function restorePendingIncomingCall(nextSession: Session) {
    const stored = await AsyncStorage.getItem(STORED_PENDING_CALL_KEY).catch(() => null);
    if (!stored) return;
    try {
      const call = JSON.parse(stored) as IncomingCall;
      if (!call.callId || !call.roomId || !call.sender || call.senderId === nextSession.userId || isExpiredCall(call.expiresAt)) {
        await AsyncStorage.removeItem(STORED_PENDING_CALL_KEY).catch(() => undefined);
        return;
      }
      if (handledCallIDsRef.current.has(call.callId)) return;
      const nextCall = { ...call, callUUID: createCallUUID() };
      handledCallIDsRef.current.add(nextCall.callId);
      nativeCallsRef.current[nextCall.callUUID] = nextCall;
      setCallPeer({ displayName: nextCall.sender });
      scheduleIncomingCallExpiration(nextCall);
      void displayNativeIncomingCall(nextCall);
      if (Platform.OS !== "ios") {
        setIncomingCall(nextCall);
        void startIncomingCallTone();
      }
    } catch {
      await AsyncStorage.removeItem(STORED_PENDING_CALL_KEY).catch(() => undefined);
    }
  }

  function scheduleIncomingCallExpiration(call: IncomingCall) {
    clearIncomingCallExpirationTimer();
    const expirationTime = call.expiresAt ? Date.parse(call.expiresAt) : Number.NaN;
    if (!Number.isFinite(expirationTime)) return;

    const delay = Math.max(0, expirationTime - Date.now());
    incomingCallExpirationTimerRef.current = setTimeout(() => {
      if (incomingCallRef.current?.callId === call.callId) {
        void declineIncomingCall({ announce: false });
        return;
      }
      clearNativeCallsForPayload(call);
    }, delay);
  }

  function clearIncomingCallExpirationTimer() {
    if (incomingCallExpirationTimerRef.current) {
      clearTimeout(incomingCallExpirationTimerRef.current);
      incomingCallExpirationTimerRef.current = null;
    }
  }

  function queueNativeAnswerCall(callUUID: string) {
    pendingNativeAcceptCallUUIDRef.current = callUUID;
    setNativeCallEventTick(current => current + 1);
  }

  function queueNativeEndCall(callUUID: string) {
    pendingNativeEndCallUUIDRef.current = callUUID;
    setNativeCallEventTick(current => current + 1);
  }

  async function acceptNativeIncomingCall(callUUID: string) {
    const call = nativeCallsRef.current[callUUID] ?? incomingCallRef.current;
    if (!call || !session) {
      pendingNativeAcceptCallUUIDRef.current = callUUID;
      return;
    }
    if (call.senderId === session.userId || isExpiredCall(call.expiresAt)) {
      clearNativeCall(call, "end");
      return;
    }
    if (activeCallRoomIDRef.current === call.roomId) return;

    activeCallUUIDRef.current = callUUID;
    activeCallIDRef.current = call.callId;
    clearIncomingCallExpirationTimer();
    setIncomingCall(null);
    incomingCallRef.current = null;
    await AsyncStorage.removeItem(STORED_PENDING_CALL_KEY).catch(() => undefined);
    await joinCall(call.mode, call.roomId, false);
    getNativeCallKeep()?.setCurrentCallActive?.(callUUID);
  }

  function trackNativeCallKeepIncomingCall(event: NativeCallKeepIncomingCallEvent) {
    if (event.fromPushKit !== "1" || !event.callUUID) return;
    const payload = normalizeIncomingCallPayload(event.payload);
    if (!payload) return;
    const call = {
      callUUID: event.callUUID,
      callId: payload.callId,
      roomId: payload.roomId,
      senderId: payload.senderId,
      sender: payload.sender,
      mode: payload.mode,
      expiresAt: payload.expiresAt
    };
    if (isExpiredCall(payload.expiresAt)) {
      clearNativeCall(call, "end");
      return;
    }
    nativeCallsRef.current[event.callUUID] = call;
    handledCallIDsRef.current.add(payload.callId);
    scheduleIncomingCallExpiration(call);
    setNativeCallEventTick(current => current + 1);
  }

  async function acceptNativeIncomingCallPayload(payload: IncomingCallPayload) {
    if (!session) {
      pendingNativeAcceptRef.current = payload;
      return;
    }
    if (payload.senderId === session.userId || isExpiredCall(payload.expiresAt)) return;

    const currentCall = incomingCallRef.current;
    if (currentCall && callMatchesPayload(currentCall, payload)) {
      activeCallUUIDRef.current = currentCall.callUUID;
      activeCallIDRef.current = currentCall.callId;
      clearIncomingCallExpirationTimer();
      setIncomingCall(null);
      incomingCallRef.current = null;
      await AsyncStorage.removeItem(STORED_PENDING_CALL_KEY).catch(() => undefined);
      await joinCall(currentCall.mode, currentCall.roomId, false);
      return;
    }
    if (activeCallRoomIDRef.current === payload.roomId) return;

    const callUUID = createCallUUID();
    activeCallUUIDRef.current = callUUID;
    activeCallIDRef.current = payload.callId;
    handledCallIDsRef.current.add(payload.callId);
    nativeCallsRef.current[callUUID] = {
      callUUID,
      callId: payload.callId,
      roomId: payload.roomId,
      senderId: payload.senderId,
      sender: payload.sender,
      mode: payload.mode,
      expiresAt: payload.expiresAt
    };
    setCallPeer({ displayName: payload.sender });
    setIncomingCall(null);
    incomingCallRef.current = null;
    await AsyncStorage.removeItem(STORED_PENDING_CALL_KEY).catch(() => undefined);
    await joinCall(payload.mode, payload.roomId, false);
  }

  async function declineNativeIncomingCallPayload(payload: IncomingCallPayload) {
    if (!session || socketRef.current?.readyState !== WebSocket.OPEN) {
      pendingNativeDeclineRef.current = payload;
      return;
    }
    if (payload.senderId === session.userId || isExpiredCall(payload.expiresAt)) return;

    sendSocket("call:reject", { roomId: payload.roomId, callId: payload.callId, reason: "rejected" });
    clearNativeCallsForPayload(payload);
    await AsyncStorage.removeItem(STORED_PENDING_CALL_KEY).catch(() => undefined);
    if (incomingCallRef.current && callMatchesPayload(incomingCallRef.current, payload)) {
      await declineIncomingCall({ announce: false });
    }
  }

  async function endNativeCall(callUUID: string) {
    const call = nativeCallsRef.current[callUUID];
    delete nativeCallsRef.current[callUUID];

    if (activeCallUUIDRef.current === callUUID) {
      await endCurrentCall({ announce: true, status: "Call ended", native: false });
      return;
    }

    if (incomingCallRef.current?.callUUID === callUUID || call) {
      if (incomingCallRef.current?.callUUID === callUUID) {
        await declineIncomingCall({ announce: true });
        return;
      }
      await declineNativeIncomingCallPayload(call);
      clearNativeCall(call, "none");
      await AsyncStorage.removeItem(STORED_PENDING_CALL_KEY).catch(() => undefined);
      setCallPeer(null);
    }
  }

  async function restoreStoredSession() {
    try {
      const stored = await AsyncStorage.getItem(STORED_SESSION_KEY);
      if (!stored) return;

      const payload = JSON.parse(stored) as StoredSession;
      if (!payload.session?.userId || !payload.session.messageKeySecret || payload.expiresAt <= Date.now()) {
        await AsyncStorage.removeItem(STORED_SESSION_KEY);
        return;
      }

      setServerURL(payload.serverURL || DEFAULT_API_URL);
      setInviteCode(payload.inviteCode || "home");
      setDisplayName(payload.session.displayName);
      setAccountEmail(payload.session.accountEmail);
      setAvatarURL(payload.session.avatarURL ?? "");
      setSession(payload.session);
      void registerDeviceForPush(payload.session, normalizeServerURL(payload.serverURL || DEFAULT_API_URL));
      void restorePendingIncomingCall(payload.session);
    } catch {
      await AsyncStorage.removeItem(STORED_SESSION_KEY).catch(() => undefined);
    }
  }

  async function persistSession(nextSession: Session, nextServerURL: string, nextInviteCode: string) {
    const payload: StoredSession = {
      session: nextSession,
      serverURL: nextServerURL,
      inviteCode: nextInviteCode,
      expiresAt: Date.now() + SESSION_TTL_MS
    };
    await AsyncStorage.setItem(STORED_SESSION_KEY, JSON.stringify(payload));
  }

  useEffect(() => {
    if (googleResponse?.type !== "success") return;
    const accessToken = googleResponse.authentication?.accessToken;
    const code = googleResponse.params.code;
    if (!accessToken) {
      if (!code || !googleRequest?.codeVerifier || !GOOGLE_CLIENT_ID) {
        Alert.alert("Google sign-in failed", "Google did not return an authorization code.");
        return;
      }

      void exchangeGoogleAuthorizationCode(code, googleRequest.codeVerifier);
      return;
    }

    void completeGoogleSignIn(accessToken);
  }, [googleRequest?.codeVerifier, googleResponse]);

  async function exchangeGoogleAuthorizationCode(code: string, codeVerifier: string) {
    try {
      const token = await AuthSession.exchangeCodeAsync(
        {
          clientId: GOOGLE_CLIENT_ID ?? "",
          code,
          redirectUri: googleRedirectURI,
          scopes: ["openid", "profile", "email"],
          extraParams: { code_verifier: codeVerifier }
        },
        GOOGLE_DISCOVERY
      );
      if (!token.accessToken) {
        Alert.alert("Google sign-in failed", "Google did not return an access token.");
        return;
      }
      await completeGoogleSignIn(token.accessToken);
    } catch {
      Alert.alert("Google sign-in failed", "Could not exchange the Google authorization code.");
    }
  }

  async function startGoogleSignIn() {
    if (Platform.OS === "web") {
      await promptGoogleSignIn();
      return;
    }

    try {
      if (Platform.OS === "android") {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      }
      const response = await GoogleSignin.signIn();
      if (response.type === "cancelled") return;
      const tokens = await GoogleSignin.getTokens();
      if (!tokens.accessToken) {
        Alert.alert("Google sign-in failed", "Google did not return an access token.");
        return;
      }
      await completeGoogleSignIn(tokens.accessToken);
    } catch {
      Alert.alert("Google sign-in failed", "Could not complete Google sign-in on this device.");
    }
  }

  async function completeGoogleSignIn(accessToken: string) {
    const profile = await loadGoogleAccount(accessToken);
    if (!profile) return;

    setGoogleAccessToken(accessToken);
    await login(accessToken, profile);
  }

  async function loadGoogleAccount(accessToken: string) {
    try {
      const response = await fetch(GOOGLE_DISCOVERY.userInfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!response.ok) {
        throw new Error(`Google userinfo failed with status ${response.status}`);
      }

      const profile = await response.json() as GoogleUserInfo;
      const email = profile.email?.trim().toLowerCase();
      if (!email || profile.email_verified === false) {
        Alert.alert("Google sign-in failed", "Use a verified Google email account.");
        return null;
      }

      setAccountEmail(email);
      setAvatarURL(normalizeAvatarURL(profile.picture ?? ""));
      setDisplayName(current => current.trim() || profile.name?.trim() || email.split("@")[0]);
      return {
        email,
        name: profile.name?.trim() || email.split("@")[0],
        picture: normalizeAvatarURL(profile.picture ?? "")
      };
    } catch {
      Alert.alert("Google sign-in failed", "Could not read the Google account email.");
      return null;
    }
  }

  async function refreshMessages(roomID = activeRoomID, userID = session?.userId) {
    if (!userID) return;
    try {
      const payload = await fetchJSON(`${apiURL}/rooms/${encodeURIComponent(roomID)}/messages?userId=${encodeURIComponent(userID)}`);
      const nextMessages = await decryptMessages((payload.messages ?? []) as Message[], session?.messageKeySecret);
      setMessages(current => messagesEqual(current, nextMessages) ? current : nextMessages);
    } catch {
      // Keep the existing view if a transient refresh fails.
    }
  }

  async function refreshMembers() {
    try {
      const payload = await fetchJSON(`${apiURL}/members`);
      const nextMembers = (payload.members ?? []) as Member[];
      setMembers(current => membersEqual(current, nextMembers) ? current : nextMembers);
    } catch {
      // Lobby refresh is opportunistic.
    }
  }

  async function refreshDirectInbox() {
    if (!session) return;
    try {
      const payload = await fetchJSON(`${apiURL}/direct/inbox?userId=${encodeURIComponent(session.userId)}`);
      const inboxMessages = (payload.messages ?? []) as Message[];
      const unreadRooms = inboxMessages
        .filter(message => message.roomId !== activeRoomID && message.senderId !== session.userId)
        .map(message => message.roomId);
      setUnreadRoomIDs(current => {
        const nextUnreadRooms = Array.from(new Set([...current.filter(roomID => roomID !== activeRoomID), ...unreadRooms]));
        return stringArraysEqual(current, nextUnreadRooms) ? current : nextUnreadRooms;
      });
      const activeInboxMessage = inboxMessages.find(message => message.roomId === activeRoomID);
      if (activeInboxMessage && selectedMember) {
        await refreshMessages(activeRoomID, session.userId);
      }
      await Promise.all(
        inboxMessages
          .filter(message => message.roomId !== activeRoomID && message.senderId !== session.userId && isDirectRoomID(message.roomId))
          .map(async message => {
            const nextMessage = await decryptMessage(message, session.messageKeySecret);
            await notifyPrivateMessage(nextMessage);
          })
      );
    } catch {
      // Direct inbox refresh prevents missed first-message notifications but is non-fatal.
    }
  }

  useEffect(() => {
    if (!session) return;
    if (E2E_MODE) {
      setConnected(true);
      return;
    }

    setUnreadRoomIDs(current => {
      const nextUnreadRooms = current.filter(roomID => roomID !== activeRoomID);
      return stringArraysEqual(current, nextUnreadRooms) ? current : nextUnreadRooms;
    });

    void refreshMessages(activeRoomID, session.userId);
    void refreshMembers();
    void refreshDirectInbox();

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const wsURL = `${apiURL.replace(/^http/, "ws")}/ws?roomId=${encodeURIComponent(activeRoomID)}&userId=${encodeURIComponent(session.userId)}&displayName=${encodeURIComponent(session.displayName)}`;
    const scheduleReconnect = () => {
      if (disposed) return;
      reconnectTimer = setTimeout(connectSocket, 1500);
    };
    const handleSocketMessage = (event: WebSocketMessageEvent) => {
      const payload = JSON.parse(event.data) as SocketEvent;
      if (payload.type === "message:new") {
        void decryptMessage(payload.data, session.messageKeySecret).then(nextMessage => {
          if (nextMessage.roomId === activeRoomID) {
            setMessages(current => mergeMessages(current, nextMessage));
          } else if (nextMessage.senderId !== session.userId) {
            setUnreadRoomIDs(current => current.includes(nextMessage.roomId) ? current : [...current, nextMessage.roomId]);
            if (isDirectRoomID(nextMessage.roomId)) {
              void notifyPrivateMessage(nextMessage);
            }
            void refreshMembers();
          }
        });
      }
      if (payload.type === "message:clear") {
        setUnreadRoomIDs(current => current.filter(roomID => roomID !== payload.data.roomId));
        if (payload.data.roomId === activeRoomID) {
          setMessages([]);
          setSelectedMember(null);
        }
      }
      if (payload.type === "call:ring" && payload.data.senderId !== session.userId) {
        void showIncomingCallFromPayload(payload.data, "websocket");
      }
      if (payload.type === "call:end" && payload.data.senderId !== session.userId) {
        if (incomingCallRef.current && callMatchesPayload(incomingCallRef.current, payload.data)) {
          void declineIncomingCall({ announce: false });
        }
        clearNativeCallsForPayload(payload.data);
        if (activeCallMatchesPayload(payload.data)) {
          void endCurrentCall({ announce: false, status: payload.data.reason === "no-answer" ? "No answer" : "Call ended" });
        }
      }
      if (payload.type === "call:reject" && payload.data.senderId !== session.userId) {
        if (incomingCallRef.current && callMatchesPayload(incomingCallRef.current, payload.data)) {
          void declineIncomingCall({ announce: false });
        }
        clearNativeCallsForPayload(payload.data);
        if (activeCallMatchesPayload(payload.data)) {
          void endCurrentCall({ announce: false, status: payload.data.reason === "no-answer" ? "No answer" : "Call rejected" });
        }
      }
      if (payload.type === "member:joined") {
        setMembers(current => upsertMember(current, payload.data));
      }
    };
    const connectSocket = () => {
      const socket = new WebSocket(wsURL);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        setConnected(false);
        scheduleReconnect();
      };
      socket.onerror = () => {
        setConnected(false);
        socket.close();
      };
      socket.onmessage = handleSocketMessage;
    };

    connectSocket();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
      void stopIncomingCallTone();
    };
  }, [activeRoomID, apiURL, session]);

  useEffect(() => {
    return () => {
      void stopIncomingCallTone();
    };
  }, []);

  useEffect(() => {
    void AsyncStorage.getItem(STORED_PRIVATE_MESSAGE_SOUND_KEY)
      .then(value => {
        if (value === "0") {
          setPrivateMessageSoundEnabled(false);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!session || E2E_MODE) return;
    const intervalID = setInterval(() => {
      void refreshMembers();
      void refreshDirectInbox();
      if (selectedMember) {
        void refreshMessages(activeRoomID, session.userId);
      }
    }, 3000);
    return () => clearInterval(intervalID);
  }, [activeRoomID, apiURL, selectedMember, session]);

  async function login(nextGoogleAccessToken = googleAccessToken, googleProfile?: { email: string; name: string; picture: string }) {
    const nextAccountEmail = (googleProfile?.email ?? accountEmail).trim().toLowerCase();
    const nextDisplayName = ((googleProfile?.name ?? displayName).trim() || nextAccountEmail.split("@")[0] || "LevelG").slice(0, 40);
    const nextAvatarURL = normalizeAvatarURL(googleProfile?.picture ?? avatarURL);

    if (E2E_MODE) {
      setSession({
        userId: "e2e-user",
        displayName: nextDisplayName || "Carlos",
        accountEmail: nextAccountEmail || "carlos@example.test",
        avatarURL: nextAvatarURL,
        messageKeySecret: "e2e-message-key-secret"
      });
      setConnected(true);
      return;
    }

    if (!nextGoogleAccessToken) {
      Alert.alert("Google sign-in required", "Use Google to create or restore the account on this device.");
      return;
    }

    try {
      const response = await fetch(`${apiURL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: nextDisplayName,
          accountEmail: nextAccountEmail,
          avatarURL: nextAvatarURL,
          googleAccessToken: nextGoogleAccessToken,
          inviteCode
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        Alert.alert("Login failed", `Server returned ${response.status}. Check the server URL and secret.${errorText ? `\n\n${errorText.slice(0, 180)}` : ""}`);
        return;
      }

      const nextSession = await response.json() as Session;
      if (!nextSession.messageKeySecret) {
        Alert.alert("Login failed", "Server did not return the message encryption key. Update the backend and try again.");
        return;
      }
      setSession(nextSession);
      await persistSession(nextSession, apiURL, inviteCode.trim());
      void registerDeviceForPush(nextSession, apiURL);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      Alert.alert("Server unreachable", `Could not connect to ${apiURL}.\n\n${message}`);
    }
  }

  async function logout() {
    const currentSession = session;
    await endCurrentCall({ announce: true, status: "Ready" }).catch(() => undefined);
    if (currentSession) {
      await unregisterDeviceForPush(currentSession, apiURL).catch(() => undefined);
    }
    socketRef.current?.close();
    socketRef.current = null;
    await stopIncomingCallTone().catch(() => undefined);
    await AsyncStorage.removeItem(STORED_SESSION_KEY).catch(() => undefined);
    setSession(null);
    setSelectedMember(null);
    setMessages([]);
    setMembers([]);
    setUnreadRoomIDs([]);
    setIncomingCall(null);
    incomingCallRef.current = null;
    setCallPeer(null);
    setConnected(false);
    setCallActive(false);
    setCallStatus("Ready");
  }

  function activeCallMatchesPayload(payload: { callId?: string; roomId: string }) {
    if (!activeCallRoomIDRef.current || payload.roomId !== activeCallRoomIDRef.current) return false;
    return !payload.callId || !activeCallIDRef.current || payload.callId === activeCallIDRef.current;
  }

  async function togglePrivateMessageSound() {
    const nextEnabled = !privateMessageSoundEnabled;
    setPrivateMessageSoundEnabled(nextEnabled);
    await AsyncStorage.setItem(STORED_PRIVATE_MESSAGE_SOUND_KEY, nextEnabled ? "1" : "0").catch(() => undefined);
    if (nextEnabled) {
      await ensurePrivateMessageNotifications();
    }
  }

  async function notifyPrivateMessage(message: Message) {
    if (!privateMessageSoundEnabledRef.current) return;
    if (notifiedPrivateMessageIDsRef.current.has(message.id)) return;
    notifiedPrivateMessageIDsRef.current.add(message.id);
    await ensurePrivateMessageNotifications();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: message.sender,
        body: message.attachment ? `Sent ${message.attachment.mimeType.startsWith("image/") ? "a photo" : "a file"}` : message.text,
        sound: PRIVATE_MESSAGE_SOUND,
        priority: Notifications.AndroidNotificationPriority.HIGH
      },
      trigger: Platform.OS === "android" ? { channelId: PRIVATE_MESSAGE_CHANNEL_ID } : null
    }).catch(() => undefined);
  }

  async function ensurePrivateMessageNotifications() {
    const currentPermissions = await Notifications.getPermissionsAsync();
    if (!currentPermissions.granted) {
      await Notifications.requestPermissionsAsync();
    }

    if (Platform.OS === "android") {
      await Notifications.deleteNotificationChannelAsync(PRIVATE_MESSAGE_CHANNEL_ID).catch(() => undefined);
      await Notifications.setNotificationChannelAsync(PRIVATE_MESSAGE_CHANNEL_ID, {
        name: "Private messages",
        importance: Notifications.AndroidImportance.HIGH,
        sound: PRIVATE_MESSAGE_SOUND
      });
    }
  }

  function sendSocket(type: string, data: unknown) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(JSON.stringify({ type, data }));
    return true;
  }

  async function sendMessage(text = draft) {
    if (!session || !text.trim()) return;
    const nextText = text.trim();
    try {
      const payload = await persistEncryptedMessage(nextText);
      const savedMessage = await decryptMessage(payload.message as Message, session.messageKeySecret);
      setMessages(current => mergeMessages(current, savedMessage));
      setDraft("");
    } catch {
      Alert.alert("Message not sent", "The server did not save this message. Check the connection and try again.");
    }
  }

  async function sendAttachment(kind: "image" | "file") {
    if (!session || !selectedMember || !canSendAttachment) return;
    try {
      setSendingAttachment(true);
      const picked = kind === "image" ? await pickImageAttachment() : await pickDocumentAttachment();
      if (!picked) return;
      if (picked.sizeBytes > MAX_ATTACHMENT_BYTES) {
        Alert.alert("File too large", "Send files up to 8 MB for now.");
        return;
      }

      const fileBytes = await readPickedAttachmentBytes(picked);
      if (fileBytes.length > MAX_ATTACHMENT_BYTES) {
        Alert.alert("File too large", "Send files up to 8 MB for now.");
        return;
      }
      const key = await deriveRoomMessageKey(activeRoomID, session.messageKeySecret);
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const encryptedFile = nacl.secretbox(fileBytes, nonce, key);
      const uploadPayload = await fetchJSON(`${apiURL}/rooms/${encodeURIComponent(activeRoomID)}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderId: session.userId,
          data: naclUtil.encodeBase64(encryptedFile)
        })
      });

      const attachmentID = String(uploadPayload.attachment?.id ?? "");
      if (!attachmentID) {
        throw new Error("missing attachment id");
      }
      const metadata: MessageAttachment = {
        attachmentId: attachmentID,
        fileName: picked.fileName,
        mimeType: picked.mimeType,
        sizeBytes: picked.sizeBytes,
        nonce: naclUtil.encodeBase64(nonce)
      };
      const messagePayload = await persistEncryptedMessage(`${ATTACHMENT_MESSAGE_PREFIX}${JSON.stringify(metadata)}`);
      const savedMessage = await decryptMessage(messagePayload.message as Message, session.messageKeySecret);
      setMessages(current => mergeMessages(current, savedMessage));
    } catch (error) {
      console.warn("Attachment send failed", error);
      Alert.alert("Attachment not sent", "The encrypted file was not saved. Check the connection and try again.");
    } finally {
      setSendingAttachment(false);
    }
  }

  async function persistEncryptedMessage(text: string) {
    if (!session) {
      throw new Error("missing session");
    }
    const encryptedText = await encryptMessageText(activeRoomID, text, session.messageKeySecret);
    return fetchJSON(`${apiURL}/rooms/${encodeURIComponent(activeRoomID)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        senderId: session.userId,
        displayName: session.displayName,
        text: encryptedText
      })
    });
  }

  async function decryptAttachmentToCache(message: Message) {
    if (!session || !message.attachment) return;
    const payload = await fetchJSON(`${apiURL}/rooms/${encodeURIComponent(message.roomId)}/attachments/${encodeURIComponent(message.attachment.attachmentId)}?userId=${encodeURIComponent(session.userId)}`);
    const encryptedData = String(payload.attachment?.data ?? "");
    const key = await deriveRoomMessageKey(message.roomId, session.messageKeySecret);
    const opened = nacl.secretbox.open(naclUtil.decodeBase64(encryptedData), naclUtil.decodeBase64(message.attachment.nonce), key);
    if (!opened) {
      throw new Error("attachment decrypt failed");
    }

    const safeName = sanitizeFileName(message.attachment.fileName);
    const targetURI = `${FileSystem.cacheDirectory ?? ""}${message.id}-${safeName}`;
    await FileSystem.writeAsStringAsync(targetURI, naclUtil.encodeBase64(opened), { encoding: FileSystem.EncodingType.Base64 });
    return targetURI;
  }

  async function loadAttachmentPreview(message: Message) {
    if (!message.attachment?.mimeType.startsWith("image/")) return;
    if (attachmentPreviewURIs[message.id] || loadingAttachmentPreviewIDsRef.current.has(message.id)) return;

    loadingAttachmentPreviewIDsRef.current.add(message.id);
    try {
      const targetURI = await decryptAttachmentToCache(message);
      if (targetURI) {
        setAttachmentPreviewURIs(current => ({ ...current, [message.id]: targetURI }));
      }
    } catch {
      // Image previews are best-effort; tapping the attachment still reports detailed failures.
    } finally {
      loadingAttachmentPreviewIDsRef.current.delete(message.id);
    }
  }

  async function openAttachment(message: Message) {
    if (!session || !message.attachment) return;
    try {
      const targetURI = attachmentPreviewURIs[message.id] ?? await decryptAttachmentToCache(message);
      if (!targetURI) {
        throw new Error("attachment unavailable");
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(targetURI, { mimeType: message.attachment.mimeType, dialogTitle: message.attachment.fileName });
      } else {
        await Linking.openURL(targetURI);
      }
    } catch {
      Alert.alert("Attachment unavailable", "The app could not download or decrypt this file.");
    }
  }

  async function deleteDirectChat() {
    if (!session || !selectedMember || !activeRoomID.startsWith("dm:")) return;

    const runDelete = async () => {
      try {
        const response = await fetch(`${apiURL}/rooms/${encodeURIComponent(activeRoomID)}/messages?userId=${encodeURIComponent(session.userId)}`, {
          method: "DELETE"
        });
        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(errorText || `delete failed with ${response.status}`);
        }
        setMessages([]);
        setUnreadRoomIDs(current => current.filter(roomID => roomID !== activeRoomID));
        setSelectedMember(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown delete error";
        Alert.alert("Chat not deleted", `The server did not delete this private chat.\n\n${message}`);
      }
    };

    Alert.alert(
      "Delete private chat",
      `Delete the 1-1 chat with ${selectedMember.displayName}? This removes the conversation for both members.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void runDelete() }
      ]
    );
  }

  async function joinCall(mode: "voice" | "video", roomID = activeRoomID, announce = true) {
    if (!session) return;
    await stopIncomingCallTone({ deactivateAudio: false });
    if (roomRef.current) {
      await endCurrentCall({ announce: false, status: "Switching call" });
    }
    activeCallRoomIDRef.current = roomID;
    activeCallIDRef.current = announce ? createCallUUID() : activeCallIDRef.current;
    setCallPeer(resolveCallPeer(roomID));
    if (!activeCallUUIDRef.current) {
      const callUUID = createCallUUID();
      activeCallUUIDRef.current = callUUID;
      if (announce) {
        try {
          getNativeCallKeep()?.startCall(callUUID, roomID, activeRoomTitle, "generic", mode === "video");
        } catch {
          // Native outgoing call UI is best-effort; the in-app call UI remains active.
        }
      }
    }
    setCallMode(mode);
    setCallActive(true);
    setCallStatus("Connecting");
    if (E2E_MODE) {
      setCallStatus("Connected");
      return;
    }

    try {
      if (!(await requestCallPermissions(mode))) {
        setCallActive(false);
        setCallStatus("Ready");
        Alert.alert("Permissions needed", mode === "video" ? "Video calls require microphone and camera permission." : "Voice calls require microphone permission.");
        return;
      }

      const response = await fetch(`${apiURL}/calls/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: roomID,
          identity: session.userId,
          displayName: session.displayName
        })
      });

      if (!response.ok) {
        throw new Error("The server could not create a call token.");
      }

      const { token } = await response.json();
      const room = new Room();
      roomRef.current = room;

      room.on(RoomEvent.Connected, () => {
        setCallActive(true);
        setCallStatus("Connected");
        setRemoteParticipantCount(room.remoteParticipants.size);
        if (announce) {
          sendSocket("call:ring", { roomId: roomID, callId: activeCallIDRef.current, mode });
          scheduleOutgoingCallUnavailable(room);
        }
        if (activeCallUUIDRef.current) {
          getNativeCallKeep()?.reportConnectedOutgoingCallWithUUID?.(activeCallUUIDRef.current);
          getNativeCallKeep()?.setCurrentCallActive?.(activeCallUUIDRef.current);
        }
      });
      room.on(RoomEvent.ParticipantConnected, () => {
        clearOutgoingCallTimeout();
        setRemoteParticipantCount(room.remoteParticipants.size);
        setCallStatus("Connected");
        syncVideoTracks(room);
      });
      room.on(RoomEvent.ParticipantDisconnected, () => {
        setRemoteParticipantCount(room.remoteParticipants.size);
        setCallStatus(room.remoteParticipants.size > 0 ? "Connected" : "Waiting for other person");
        syncVideoTracks(room);
      });
      room.on(RoomEvent.TrackSubscribed, () => {
        syncVideoTracks(room);
      });
      room.on(RoomEvent.TrackUnsubscribed, () => {
        syncVideoTracks(room);
      });
      room.on(RoomEvent.LocalTrackPublished, () => {
        syncVideoTracks(room);
      });
      room.on(RoomEvent.LocalTrackUnpublished, () => {
        syncVideoTracks(room);
      });
      room.on(RoomEvent.Reconnecting, () => {
        setCallStatus("Reconnecting");
      });
      room.on(RoomEvent.Reconnected, () => {
        setRemoteParticipantCount(room.remoteParticipants.size);
        setCallStatus("Connected");
      });
      room.on(RoomEvent.Disconnected, () => {
        activeCallRoomIDRef.current = null;
        setCallActive(false);
        setCallStatus("Ready");
        setRemoteParticipantCount(0);
      });

      await room.connect(LIVEKIT_URL, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (mode === "video") {
        try {
          const cameraPublication = await room.localParticipant.setCameraEnabled(true, { facingMode: "user", resolution: { width: 1280, height: 720, frameRate: 30 } });
          if (isVideoTrack(cameraPublication?.track)) {
            setLocalVideoTrack(cameraPublication.track);
          }
          setCameraFacingMode("user");
          syncVideoTracks(room);
        } catch {
          setCallMode("voice");
          Alert.alert("Video unavailable", "The call is connected with audio. Camera publishing failed on this device.");
        }
      }
    } catch (error) {
      await endCurrentCall({ announce: false, status: "Ready" });
      Alert.alert("Call failed", error instanceof Error ? error.message : "Unable to start the call.");
    }
  }

  async function leaveCall() {
    await endCurrentCall({ announce: true, status: "Call ended" });
  }

  function scheduleOutgoingCallUnavailable(room: Room) {
    clearOutgoingCallTimeout();
    outgoingCallTimeoutRef.current = setTimeout(() => {
      if (roomRef.current === room && room.remoteParticipants.size === 0) {
        void endCurrentCall({ announce: true, status: "No answer", reason: "no-answer" });
      }
    }, CALL_RING_TIMEOUT_MS);
  }

  function clearOutgoingCallTimeout() {
    if (outgoingCallTimeoutRef.current) {
      clearTimeout(outgoingCallTimeoutRef.current);
      outgoingCallTimeoutRef.current = null;
    }
  }

  async function endCurrentCall({ announce, status, native = true, reason }: { announce: boolean; status: string; native?: boolean; reason?: string }) {
    await stopIncomingCallTone();
    clearOutgoingCallTimeout();
    const roomID = activeCallRoomIDRef.current;
    const callID = activeCallIDRef.current;
    const callUUID = activeCallUUIDRef.current;
    if (announce && roomID) {
      sendSocket("call:end", { roomId: roomID, callId: callID, reason });
    }
    if (native && callUUID) {
      getNativeCallKeep()?.endCall(callUUID);
    }
    const room = roomRef.current;
    roomRef.current = null;
    activeCallRoomIDRef.current = null;
    activeCallIDRef.current = null;
    activeCallUUIDRef.current = null;
    if (callUUID) {
      delete nativeCallsRef.current[callUUID];
    }
    if (room) {
      await room.localParticipant.setCameraEnabled(false).catch(() => undefined);
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      await stopPublishedMedia(room);
      await room.disconnect(true).catch(() => undefined);
      room.removeAllListeners();
    }
    setLocalVideoTrack(undefined);
    setRemoteVideoTrack(undefined);
    setCameraFacingMode("user");
    setCallPeer(null);
    await resetAudioSession();
    setCallActive(false);
    setCallStatus(status);
    setRemoteParticipantCount(0);
  }

  async function declineIncomingCall(options: { announce?: boolean } = {}) {
    const call = incomingCallRef.current;
    if (options.announce !== false && call) {
      sendSocket("call:reject", { roomId: call.roomId, callId: call.callId, reason: "rejected" });
      getNativeCallKeep()?.rejectCall(call.callUUID);
    } else if (call) {
      getNativeCallKeep()?.endCall(call.callUUID);
    }
    if (call) {
      clearNativeCall(call, "none");
    }
    clearIncomingCallExpirationTimer();
    await stopIncomingCallTone();
    await AsyncStorage.removeItem(STORED_PENDING_CALL_KEY).catch(() => undefined);
    setIncomingCall(null);
    incomingCallRef.current = null;
    setCallPeer(null);
  }

  async function acceptIncomingCall() {
    if (!incomingCall) return;
    const nextCall = incomingCall;
    activeCallUUIDRef.current = nextCall.callUUID;
    activeCallIDRef.current = nextCall.callId;
    setCallPeer({ displayName: nextCall.sender });
    clearIncomingCallExpirationTimer();
    setIncomingCall(null);
    await AsyncStorage.removeItem(STORED_PENDING_CALL_KEY).catch(() => undefined);
    await joinCall(nextCall.mode, nextCall.roomId, false);
    getNativeCallKeep()?.setCurrentCallActive?.(nextCall.callUUID);
  }

  function clearNativeCallsForPayload(payload: { callId?: string; roomId: string }) {
    Object.values(nativeCallsRef.current)
      .filter(call => callMatchesPayload(call, payload))
      .forEach(call => clearNativeCall(call, "end"));
  }

  function clearNativeCall(call: IncomingCall, nativeAction: "end" | "reject" | "none") {
    if (nativeAction === "end") {
      getNativeCallKeep()?.endCall(call.callUUID);
    }
    if (nativeAction === "reject") {
      getNativeCallKeep()?.rejectCall(call.callUUID);
    }
    delete nativeCallsRef.current[call.callUUID];
  }

  async function startIncomingCallTone() {
    Vibration.vibrate([0, 750, 350], true);
    try {
      await ensureIncomingCallNotifications();
      if (incomingCallNotificationRef.current) {
        await Notifications.dismissNotificationAsync(incomingCallNotificationRef.current).catch(() => undefined);
      }

      const call = incomingCallRef.current;
      const notificationID = await Notifications.scheduleNotificationAsync({
        content: {
          title: call?.mode === "video" ? "Incoming video call" : "Incoming voice call",
          body: call?.sender ? `${call.sender} is calling on Phone LevelG` : "Phone LevelG call",
          sound: DEFAULT_RINGTONE_SOUND,
          priority: Notifications.AndroidNotificationPriority.MAX
        },
        trigger: Platform.OS === "android" ? { channelId: INCOMING_CALL_CHANNEL_ID } : null
      });
      incomingCallNotificationRef.current = notificationID;
    } catch {
      // Vibration remains active if the platform refuses notification playback.
    }
  }

  async function stopIncomingCallTone(options: { deactivateAudio?: boolean } = {}) {
    Vibration.cancel();
    const notificationID = incomingCallNotificationRef.current;
    incomingCallNotificationRef.current = null;
    if (notificationID) {
      await Notifications.dismissNotificationAsync(notificationID).catch(() => undefined);
    }
    if (options.deactivateAudio !== false) {
      await resetAudioSession();
    }
  }

  async function ensureIncomingCallNotifications() {
    const currentPermissions = await Notifications.getPermissionsAsync();
    if (!currentPermissions.granted) {
      await Notifications.requestPermissionsAsync();
    }

    if (Platform.OS === "android") {
      await Notifications.deleteNotificationChannelAsync(INCOMING_CALL_CHANNEL_ID).catch(() => undefined);
      await Notifications.setNotificationChannelAsync(INCOMING_CALL_CHANNEL_ID, {
        name: "Incoming calls",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 750, 350],
        sound: DEFAULT_RINGTONE_SOUND
      });
    }
  }

  async function resetAudioSession() {
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "mixWithOthers",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false
      });
      await setIsAudioActiveAsync(false);
    } catch {
      // Audio session reset is best-effort; media tracks are stopped separately.
    }
  }

  function syncVideoTracks(room: Room) {
    const localCameraTrack = Array.from(room.localParticipant.videoTrackPublications.values())
      .map(publication => publication.track)
      .find(isVideoTrack);
    const nextLocalVideoTrack = isVideoTrack(localCameraTrack) ? localCameraTrack : undefined;
    let nextRemoteVideoTrack: LiveKitVideoTrack | undefined;
    for (const participant of room.remoteParticipants.values()) {
      const remoteCameraTrack = Array.from(participant.videoTrackPublications.values())
        .map(publication => publication.track)
        .find(isVideoTrack);
      if (isVideoTrack(remoteCameraTrack)) {
        nextRemoteVideoTrack = remoteCameraTrack;
        break;
      }
    }

    setLocalVideoTrack(nextLocalVideoTrack);
    setRemoteVideoTrack(nextRemoteVideoTrack);
  }

  async function flipCamera() {
    const room = roomRef.current;
    if (!room || callMode !== "video") return;
    const nextFacingMode = cameraFacingMode === "user" ? "environment" : "user";

    try {
      setLocalVideoTrack(undefined);
      const cameraPublication = room.localParticipant.getTrackPublication(Track.Source.Camera);
      await cameraPublication?.videoTrack?.restartTrack({ facingMode: nextFacingMode, resolution: { width: 1280, height: 720, frameRate: 30 } });
      setCameraFacingMode(nextFacingMode);
      syncVideoTracks(room);
      setTimeout(() => {
        if (roomRef.current === room) {
          syncVideoTracks(room);
        }
      }, 250);
    } catch {
      syncVideoTracks(room);
      Alert.alert("Camera unavailable", "The app could not switch to the other camera.");
    }
  }

  async function stopPublishedMedia(room: Room) {
    const localTracks = Array.from(room.localParticipant.trackPublications.values())
      .map(publication => publication.track)
      .filter((track): track is NonNullable<typeof track> => Boolean(track));

    await Promise.all(localTracks.map(track => room.localParticipant.unpublishTrack(track, true).catch(() => undefined)));
    localTracks.forEach(track => {
      track.detach();
      track.stop();
      track.mediaStreamTrack.stop();
    });

    room.remoteParticipants.forEach(participant => {
      participant.trackPublications.forEach(publication => {
        publication.track?.stop();
      });
    });
  }

  function resolveCallPeer(roomID: string): CallPeer {
    if (!session) {
      return { displayName: activeRoomTitle };
    }

    if (selectedMember && roomID === directRoomID(session.userId, selectedMember.id)) {
      return { displayName: selectedMember.displayName, avatarURL: selectedMember.avatarURL };
    }

    if (roomID.startsWith("dm:")) {
      const peerID = roomID.split(":").find(part => part !== "dm" && part !== session.userId);
      const peer = members.find(member => member.id === peerID);
      if (peer) {
        return { displayName: peer.displayName, avatarURL: peer.avatarURL };
      }
    }

    return { displayName: activeRoomTitle };
  }

  if (!session) {
    return (
      <View style={styles.shell}>
        <ExpoStatusBar style="light" />
        <View style={styles.loginHero}>
          <View style={styles.logoMark}>
            <Image source={require("./assets/icon.png")} style={styles.logoImage} />
          </View>
          <Text style={styles.title}>Phone LevelG</Text>
          <Text style={styles.subtitle}>Private calls and messages for your home network.</Text>
        </View>
        <View style={styles.loginPanel}>
          <Pressable
            disabled={!googleSignInReady}
            style={[styles.googleAccountBox, !googleSignInReady && styles.disabledButton]}
            onPress={() => void startGoogleSignIn()}
          >
            <View style={styles.googleGMark}>
              <Text style={styles.googleGText}>G</Text>
            </View>
            <View style={styles.googleAccountText}>
              <Text style={styles.googleAccountTitle}>
                {googleAuthConfigured ? "Continue with Google" : "Configure Google OAuth"}
              </Text>
              <Text style={styles.googleAccountSubtitle} numberOfLines={1}>
                {accountEmail || "Gmail account, name, and profile icon"}
              </Text>
            </View>
          </Pressable>
          {accountEmail && (
            <View style={styles.accountPill}>
              <Text style={styles.accountPillLabel}>Google account</Text>
              <Text style={styles.accountPillText} numberOfLines={1}>{accountEmail}</Text>
            </View>
          )}
          <TextInput
            value={serverURL}
            onChangeText={setServerURL}
            placeholder="Server URL"
            placeholderTextColor="#7c8794"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
          />
          <TextInput
            value={inviteCode}
            onChangeText={setInviteCode}
            placeholder="Server secret"
            placeholderTextColor="#7c8794"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => void login()}
            secureTextEntry
            style={styles.input}
          />
          <Text style={styles.loginHint}>Default server: OpenShift. Google creates the account; the server URL and secret choose the private backend.</Text>
          <Pressable style={styles.primaryButton} onPress={() => void login()}>
            <Text style={styles.primaryButtonText}>Connect</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (isFullScreenCall) {
    return (
      <View style={styles.fullScreenCall}>
        <ExpoStatusBar style="light" />
        {callMode === "video" ? (
          <View style={styles.fullScreenVideoFrame}>
            {remoteVideoTrack ? (
              <CameraStreamView key={remoteVideoTrack.sid} track={remoteVideoTrack} zOrder={0} />
            ) : (
              <View style={styles.fullScreenVideoPlaceholder}>
                <View style={styles.fullScreenVideoWaitingAvatar}>
                  <UserAvatar displayName={callPeerName} avatarURL={callPeer?.avatarURL} size={116} textStyle={styles.voiceAvatarText} />
                </View>
                <Text style={styles.fullScreenVideoWaitingName} numberOfLines={1}>{callPeerName}</Text>
                <Text style={styles.fullScreenVideoWaitingStatus}>Calling {callPeerName}</Text>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.fullScreenVoiceFrame}>
            <View style={styles.voiceAvatar}>
              <UserAvatar displayName={callPeerName} avatarURL={callPeer?.avatarURL} size={118} textStyle={styles.voiceAvatarText} />
            </View>
          </View>
        )}
        <View style={styles.fullScreenCallHeader}>
          <View style={styles.fullScreenPeerAvatar}>
            <UserAvatar displayName={callPeerName} avatarURL={callPeer?.avatarURL} size={44} textStyle={styles.fullScreenPeerAvatarText} />
          </View>
          <View style={styles.fullScreenPeerText}>
            <Text style={styles.fullScreenCallingText} numberOfLines={1}>Calling {callPeerName}</Text>
            <Text style={styles.fullScreenStatusText} numberOfLines={1}>{callStatus}</Text>
          </View>
        </View>
        {callMode === "video" && localVideoTrack && (
          <View style={styles.fullScreenLocalVideoFrame}>
            <CameraStreamView key={localVideoTrack.sid} track={localVideoTrack} mirror zOrder={1} />
          </View>
        )}
        {callMode === "video" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch camera"
            hitSlop={12}
            style={styles.fullScreenFlipCameraButton}
            onPress={() => void flipCamera()}
          >
            <SwitchCamera color="#ffffff" size={22} />
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End call"
          hitSlop={16}
          style={styles.fullScreenHangupButton}
          onPress={leaveCall}
        >
          <PhoneOff color="#ffffff" size={28} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.shell}>
      <ExpoStatusBar style="light" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.chatLayout}
      >
        <View style={styles.header}>
          <View style={styles.identity}>
            <View style={styles.avatar}>
              <UserAvatar displayName={session.displayName} avatarURL={session.avatarURL} size={46} textStyle={styles.avatarText} />
              <View style={[styles.presence, connected ? styles.online : styles.offline]} />
            </View>
            <View>
              <Text style={styles.roomTitle} numberOfLines={1}>{headerTitle}</Text>
              <Text style={styles.status}>{connectionStatus}</Text>
            </View>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show lobby members and contacts"
              accessibilityState={{ expanded: contactsOpen }}
              hitSlop={12}
              android_ripple={{ color: "#6d28d9", borderless: false }}
              style={[styles.secondaryIconButton, contactsOpen && styles.headerButtonActive]}
              onPress={() => {
                setContactsOpen(current => !current);
                setOptionsOpen(false);
              }}
            >
              <Users color="#f8fafc" size={19} />
              {members.length > 0 && (
                <Text style={styles.headerBadge}>{Math.min(members.length, 99)}</Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open options"
              accessibilityState={{ expanded: optionsOpen }}
              hitSlop={12}
              android_ripple={{ color: "#6d28d9", borderless: false }}
              style={[styles.secondaryIconButton, optionsOpen && styles.headerButtonActive]}
              onPress={() => {
                setOptionsOpen(current => !current);
                setContactsOpen(false);
              }}
            >
              <Settings color="#f8fafc" size={19} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Start voice call in ${activeRoomTitle}`}
              hitSlop={12}
              android_ripple={{ color: "#6d28d9", borderless: false }}
              style={styles.iconButton}
              onPress={() => void joinCall("voice")}
            >
              <Phone color="#f8fafc" size={20} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Start video call in ${activeRoomTitle}`}
              hitSlop={12}
              android_ripple={{ color: "#6d28d9", borderless: false }}
              style={styles.iconButton}
              onPress={() => void joinCall("video")}
            >
              <Video color="#f8fafc" size={21} />
            </Pressable>
          </View>
        </View>

        <Modal transparent visible={optionsOpen} animationType="fade" onRequestClose={() => setOptionsOpen(false)}>
          <View style={styles.menuOverlay}>
            <Pressable accessibilityLabel="Close options" style={StyleSheet.absoluteFill} onPress={() => setOptionsOpen(false)} />
            <View style={styles.optionsMenuSheet}>
              <View style={styles.menuHeader}>
                <Settings color="#f8fafc" size={18} />
                <Text style={styles.menuTitle}>Options</Text>
              </View>
              <MessageSoundToggle enabled={privateMessageSoundEnabled} onPress={() => void togglePrivateMessageSound()} />
              {Platform.OS === "ios" ? (
                <>
                  <View style={styles.optionsSectionHeader}>
                    <Text style={styles.optionsSectionTitle}>iPhone call permissions</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Enable iPhone call permissions"
                      hitSlop={10}
                      style={styles.permissionSettingsButton}
                      onPress={() => void requestIPhoneCallPermissions()}
                    >
                      <Settings color="#f8fafc" size={17} />
                    </Pressable>
                  </View>
                  <View style={styles.permissionStrip}>
                    <PermissionToggle
                      icon={Bell}
                      label="Call alerts"
                      state={iosCallAlertPermission}
                      onPress={() => void requestIPhoneCallAlertPermission()}
                    />
                    <PermissionToggle
                      icon={Mic}
                      label="Mic"
                      state={iosMicPermission}
                      onPress={() => void requestIPhoneMicPermission()}
                    />
                    <PermissionToggle
                      icon={Camera}
                      label="Camera"
                      state={iosCameraPermission}
                      onPress={() => void requestIPhoneCameraPermission()}
                    />
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.optionsSectionTitle}>Android call permissions</Text>
                  <View style={styles.permissionStrip}>
                    <OptionActionButton icon={Mic} label="Mic" onPress={() => void requestCallPermissions("voice")} />
                    <OptionActionButton icon={Camera} label="Camera" onPress={() => void requestCallPermissions("video")} />
                  </View>
                </>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Log out"
                hitSlop={10}
                style={styles.optionLogoutButton}
                onPress={() => void logout()}
              >
                <LogOut color="#f8fafc" size={18} />
                <Text style={styles.optionLogoutText}>Log out</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal transparent visible={contactsOpen} animationType="fade" onRequestClose={() => setContactsOpen(false)}>
          <View style={styles.menuOverlay}>
            <Pressable accessibilityLabel="Close contacts" style={StyleSheet.absoluteFill} onPress={() => setContactsOpen(false)} />
            <View style={styles.contactsMenuSheet}>
              <View style={styles.lobbyHeader}>
                <Users color="#596575" size={17} />
                <Text style={styles.lobbyTitle}>Lobby members and contacts</Text>
                <Text style={styles.lobbyCount}>{members.length}</Text>
              </View>
              <FlatList
                horizontal
                data={members}
                keyExtractor={item => item.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.memberList}
                renderItem={({ item }) => {
                  const mine = item.id === session.userId;
                  const roomID = mine ? ROOM_ID : directRoomID(session.userId, item.id);
                  const unread = unreadRoomIDs.includes(roomID);
                  return (
                    <Pressable
                      style={[
                        styles.memberChip,
                        mine && styles.memberChipMine,
                        selectedMember?.id === item.id && styles.memberChipSelected
                      ]}
                      disabled={mine}
                      onPress={() => {
                        setSelectedMember(item);
                        setContactsOpen(false);
                      }}
                    >
                      <View style={styles.memberAvatar}>
                        <UserAvatar displayName={item.displayName} avatarURL={item.avatarURL} size={34} textStyle={styles.memberAvatarText} />
                      </View>
                      <View>
                        <Text style={styles.memberName} numberOfLines={1}>{item.displayName}</Text>
                        <Text style={styles.memberMeta}>{mine ? "You" : unread ? "New message" : selectedMember?.id === item.id ? "Private chat" : "Tap to chat"}</Text>
                      </View>
                      {unread && <View style={styles.unreadDot} />}
                    </Pressable>
                  );
                }}
              />
              {selectedMember && (
                <View style={styles.privateChatActions}>
                  <Pressable style={styles.homeRoomButton} onPress={() => setSelectedMember(null)}>
                    <Text style={styles.homeRoomText}>Back to Home room</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete private chat with ${selectedMember.displayName}`}
                    hitSlop={12}
                    style={styles.deleteChatButton}
                    onPress={() => void deleteDirectChat()}
                  >
                    <Trash2 color="#7c2d12" size={18} />
                    <Text style={styles.deleteChatText}>Delete chat</Text>
                  </Pressable>
                </View>
              )}
            </View>
          </View>
        </Modal>

        {incomingCall && (
          <View style={styles.incomingCallOverlay}>
            <View style={styles.incomingCallContent}>
              <View style={styles.incomingPulse}>
                {incomingCall.mode === "video" ? <Video color="#ffffff" size={42} /> : <Phone color="#ffffff" size={42} />}
              </View>
              <Text style={styles.incomingLabel}>Incoming {incomingCall.mode === "video" ? "video" : "voice"} call</Text>
              <Text style={styles.incomingName}>{incomingCall.sender}</Text>
              <Text style={styles.incomingHint}>Phone LevelG</Text>
            </View>
            <View style={styles.incomingActions}>
              <Pressable accessibilityLabel="Decline incoming call" style={[styles.callActionButton, styles.declineButton]} onPress={() => void declineIncomingCall()}>
                <PhoneOff color="#ffffff" size={24} />
              </Pressable>
              <Pressable accessibilityLabel="Answer incoming call" style={[styles.callActionButton, styles.acceptButton]} onPress={acceptIncomingCall}>
                <Phone color="#ffffff" size={24} />
              </Pressable>
            </View>
          </View>
        )}

        <FlatList
          data={messages}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.messages}
          renderItem={({ item }) => {
            const mine = item.senderId === session.userId;
            const attachmentPreviewURI = attachmentPreviewURIs[item.id];
            const AttachmentIcon = item.attachment?.mimeType.startsWith("image/") ? ImageIcon : FileText;
            return (
              <View style={[styles.messageGroup, mine ? styles.groupMine : styles.groupTheirs]}>
                <Text style={[styles.sender, mine && styles.senderMine]}>{mine ? "You" : item.sender}</Text>
                <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                  {item.attachment ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open encrypted attachment ${item.attachment.fileName}`}
                      style={styles.attachmentCard}
                      onPress={() => void openAttachment(item)}
                    >
                      {attachmentPreviewURI ? (
                        <Image source={{ uri: attachmentPreviewURI }} style={styles.attachmentImagePreview} resizeMode="cover" />
                      ) : (
                        <View style={styles.attachmentIcon}>
                          <AttachmentIcon color="#4c1d95" size={22} />
                        </View>
                      )}
                      <View style={styles.attachmentTextBlock}>
                        <Text style={styles.attachmentName} numberOfLines={1}>{item.attachment.fileName}</Text>
                        <Text style={styles.attachmentMeta}>{formatFileSize(item.attachment.sizeBytes)} encrypted</Text>
                      </View>
                    </Pressable>
                  ) : (
                    <Text style={styles.messageText}>{item.text}</Text>
                  )}
                </View>
                <Text style={styles.timestamp}>
                  {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </Text>
              </View>
            );
          }}
        />

        <View style={styles.emojiRow}>
          <View style={styles.emojiLead}>
            <Smile color="#596575" size={18} />
          </View>
          {QUICK_EMOJIS.map(emoji => (
            <Pressable key={emoji} style={styles.emojiButton} onPress={() => sendMessage(emoji)}>
              <Text style={styles.emoji}>{emoji}</Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show cat meme presets"
            accessibilityState={{ expanded: catMemesOpen }}
            disabled={!connected}
            hitSlop={8}
            style={[styles.emojiButton, styles.catMemeIconButton, !connected && styles.disabledButton, catMemesOpen && styles.catMemeIconButtonOpen]}
            onPress={() => setCatMemesOpen(current => !current)}
          >
            <Text style={styles.emoji}>🐱</Text>
          </Pressable>
        </View>

        {catMemesOpen && (
          <FlatList
            horizontal
            data={CAT_MEMES}
            keyExtractor={item => item.label}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.catMemeList}
            style={styles.catMemeRow}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Send cat meme ${item.label}`}
                disabled={!connected}
                style={[styles.catMemeButton, !connected && styles.disabledButton]}
                onPress={() => {
                  sendMessage(item.text);
                  setCatMemesOpen(false);
                }}
              >
                <Text style={styles.catMemeIcon}>🐱</Text>
                <Text style={styles.catMemeLabel}>{item.label}</Text>
              </Pressable>
            )}
          />
        )}

        <View style={styles.composer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach encrypted document"
            disabled={!canSendAttachment}
            hitSlop={8}
            style={[styles.attachButton, !canSendAttachment && styles.disabledButton]}
            onPress={() => void sendAttachment("file")}
          >
            <Paperclip color="#4c1d95" size={19} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach encrypted photo"
            disabled={!canSendAttachment}
            hitSlop={8}
            style={[styles.attachButton, !canSendAttachment && styles.disabledButton]}
            onPress={() => void sendAttachment("image")}
          >
            <ImageIcon color="#4c1d95" size={19} />
          </Pressable>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Message"
            placeholderTextColor="#7c8794"
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={() => sendMessage()}
            style={styles.messageInput}
          />
          <Pressable
            disabled={!canSend}
            style={[styles.sendButton, !canSend && styles.disabledButton]}
            onPress={() => sendMessage()}
          >
            <SendHorizontal color="#ffffff" size={20} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function PermissionToggle({ icon: Icon, label, state, onPress }: { icon: ComponentType<{ color?: string; size?: number }>; label: string; state: PermissionState; onPress: () => void }) {
  const enabled = state === "granted";
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled }}
      accessibilityLabel={`${label} permission`}
      hitSlop={8}
      style={[styles.permissionToggle, enabled && styles.permissionToggleOn, state === "denied" && styles.permissionToggleDenied]}
      onPress={onPress}
    >
      <Icon color={enabled ? "#062a1a" : "#f8fafc"} size={15} />
      <Text style={[styles.permissionToggleText, enabled && styles.permissionToggleTextOn]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.permissionStateText, enabled && styles.permissionStateTextOn]} numberOfLines={1}>
        {enabled ? "On" : "Enable"}
      </Text>
    </Pressable>
  );
}

function OptionActionButton({ icon: Icon, label, onPress }: { icon: ComponentType<{ color?: string; size?: number }>; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} permission`}
      hitSlop={8}
      style={styles.permissionToggle}
      onPress={onPress}
    >
      <Icon color="#f8fafc" size={15} />
      <Text style={styles.permissionToggleText} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.permissionStateText} numberOfLines={1}>
        Enable
      </Text>
    </Pressable>
  );
}

function MessageSoundToggle({ enabled, onPress }: { enabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled }}
      accessibilityLabel="Private message sound"
      hitSlop={8}
      style={styles.messageSoundToggle}
      onPress={onPress}
    >
      <Bell color={enabled ? "#062a1a" : "#f8fafc"} size={15} />
      <Text style={[styles.messageSoundToggleText, enabled && styles.messageSoundToggleTextOn]} numberOfLines={1}>
        Private message sound
      </Text>
      <View style={[styles.messageSoundSwitch, enabled && styles.messageSoundSwitchOn]}>
        <View style={[styles.messageSoundKnob, enabled && styles.messageSoundKnobOn]} />
      </View>
    </Pressable>
  );
}

function CameraStreamView({ track, mirror, zOrder }: { track: LiveKitVideoTrack; mirror?: boolean; zOrder?: number }) {
  const [streamURL, setStreamURL] = useState("");

  useEffect(() => {
    let cancelled = false;
    const mediaStream = track.mediaStream as unknown as { toURL?: () => string } | undefined;
    setStreamURL("");
    const nextStreamURL = mediaStream?.toURL?.() ?? "";
    requestAnimationFrame(() => {
      if (!cancelled) {
        setStreamURL(nextStreamURL);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [track, track.mediaStreamTrack?.id]);

  if (!streamURL) {
    return (
      <View style={styles.localVideoFallback}>
        <Video color="#ffffff" size={20} />
      </View>
    );
  }

  if (!NativeRTCView) {
    return (
      <View style={styles.localVideoFallback}>
        <Video color="#ffffff" size={20} />
      </View>
    );
  }

  return (
    <NativeRTCView
      streamURL={streamURL}
      style={styles.videoView}
      objectFit="cover"
      mirror={mirror}
      zOrder={Platform.OS === "android" ? zOrder : undefined}
    />
  );
}

async function fetchJSON(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}

function getQueryParam(name: string) {
  const location = (globalThis as unknown as { location?: { search?: string } }).location;
  if (!location?.search) return null;
  return new URLSearchParams(location.search).get(name);
}

function upsertMember(current: Member[], next: Member) {
  const existing = current.filter(member => member.id !== next.id);
  return [next, ...existing].slice(0, 100);
}

function mergeMessages(current: Message[], next: Message) {
  if (current.some(message => message.id === next.id)) {
    return current;
  }
  return [...current, next];
}

async function encryptMessageText(roomID: string, text: string, messageKeySecret: string) {
  if (E2E_MODE) return text;
  const key = await deriveRoomMessageKey(roomID, messageKeySecret);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(naclUtil.decodeUTF8(text), nonce, key);
  return `${ENCRYPTED_MESSAGE_PREFIX}${naclUtil.encodeBase64(nonce)}:${naclUtil.encodeBase64(box)}`;
}

async function decryptMessages(messages: Message[], messageKeySecret?: string) {
  return Promise.all(messages.map(message => decryptMessage(message, messageKeySecret)));
}

async function decryptMessage(message: Message, messageKeySecret?: string) {
  if (!isEncryptedMessageText(message.text)) return message;
  if (!messageKeySecret) return { ...message, text: ENCRYPTED_MESSAGE_UNAVAILABLE };
  try {
    const encryptedPayload = message.text.slice(ENCRYPTED_MESSAGE_PREFIX.length);
    const [nonceText, boxText] = encryptedPayload.split(":");
    if (!nonceText || !boxText) {
      return { ...message, text: ENCRYPTED_MESSAGE_UNAVAILABLE };
    }

    const key = await deriveRoomMessageKey(message.roomId, messageKeySecret);
    const opened = nacl.secretbox.open(naclUtil.decodeBase64(boxText), naclUtil.decodeBase64(nonceText), key);
    if (!opened) {
      return { ...message, text: ENCRYPTED_MESSAGE_UNAVAILABLE };
    }
    const decryptedText = naclUtil.encodeUTF8(opened);
    const attachment = parseAttachmentMessage(decryptedText);
    if (attachment) {
      return { ...message, text: attachment.fileName, attachment };
    }
    return { ...message, text: decryptedText };
  } catch {
    return { ...message, text: ENCRYPTED_MESSAGE_UNAVAILABLE };
  }
}

function isEncryptedMessageText(text: string) {
  return text.startsWith(ENCRYPTED_MESSAGE_PREFIX);
}

async function deriveRoomMessageKey(roomID: string, messageKeySecret: string) {
  const secret = messageKeySecret.trim();
  if (!secret) {
    throw new Error("missing message encryption secret");
  }
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${secret}:${roomID}`);
  const pairs = digest.match(/.{1,2}/g) ?? [];
  return Uint8Array.from(pairs.map(pair => Number.parseInt(pair, 16)));
}

function parseAttachmentMessage(text: string): MessageAttachment | null {
  if (!text.startsWith(ATTACHMENT_MESSAGE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(ATTACHMENT_MESSAGE_PREFIX.length)) as Partial<MessageAttachment>;
    if (!parsed.attachmentId || !parsed.fileName || !parsed.mimeType || !parsed.nonce) {
      return null;
    }
    return {
      attachmentId: String(parsed.attachmentId),
      fileName: String(parsed.fileName).slice(0, 160),
      mimeType: String(parsed.mimeType).slice(0, 120),
      sizeBytes: Number.isFinite(parsed.sizeBytes) ? Number(parsed.sizeBytes) : 0,
      nonce: String(parsed.nonce)
    };
  } catch {
    return null;
  }
}

async function pickDocumentAttachment(): Promise<AttachmentUpload | null> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, base64: true });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    fileName: sanitizeFileName(asset.name || `document-${Date.now()}`),
    mimeType: asset.mimeType || "application/octet-stream",
    sizeBytes: asset.size ?? base64ByteLength(asset.base64) ?? await fileSize(asset.uri),
    base64: asset.base64
  };
}

async function pickImageAttachment(): Promise<AttachmentUpload | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    Alert.alert("Photos unavailable", "Allow photo library access to send encrypted pictures.");
    return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.9,
    allowsEditing: false,
    base64: true
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    fileName: sanitizeFileName(asset.fileName || `photo-${Date.now()}.jpg`),
    mimeType: asset.mimeType || "image/jpeg",
    sizeBytes: asset.fileSize ?? base64ByteLength(asset.base64) ?? await fileSize(asset.uri),
    base64: asset.base64 ?? undefined
  };
}

async function readPickedAttachmentBytes(picked: AttachmentUpload) {
  if (picked.base64) {
    return naclUtil.decodeBase64(picked.base64);
  }
  try {
    const fileBase64 = await FileSystem.readAsStringAsync(picked.uri, { encoding: FileSystem.EncodingType.Base64 });
    return naclUtil.decodeBase64(fileBase64);
  } catch {
    const response = await fetch(picked.uri);
    if (!response.ok) {
      throw new Error(`attachment file read failed with status ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

async function fileSize(uri: string) {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists ? info.size ?? 0 : 0;
}

function base64ByteLength(value?: string | null) {
  if (!value) return null;
  const trimmed = value.replace(/\s/g, "");
  if (!trimmed) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

function sanitizeFileName(value: string) {
  const cleaned = value.trim().replace(/[^\w. -]+/g, "_").replace(/\s+/g, " ").slice(0, 140);
  return cleaned || `attachment-${Date.now()}`;
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function messagesEqual(left: Message[], right: Message[]) {
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    return other &&
      message.id === other.id &&
      message.roomId === other.roomId &&
      message.senderId === other.senderId &&
      message.sender === other.sender &&
      message.text === other.text &&
      message.createdAt === other.createdAt;
  });
}

function membersEqual(left: Member[], right: Member[]) {
  if (left.length !== right.length) return false;
  return left.every((member, index) => {
    const other = right[index];
    return other &&
      member.id === other.id &&
      member.displayName === other.displayName &&
      member.avatarURL === other.avatarURL &&
      member.createdAt === other.createdAt &&
      member.lastSeenAt === other.lastSeenAt &&
      member.lastReachableAt === other.lastReachableAt &&
      member.reachable === other.reachable;
  });
}

function stringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const second = words.length > 1 ? words[1][0] : "";
  return `${first}${second}`.toUpperCase();
}

function UserAvatar({ displayName, avatarURL, size, textStyle }: { displayName: string; avatarURL?: string; size: number; textStyle: StyleProp<TextStyle> }) {
  const safeAvatarURL = normalizeAvatarURL(avatarURL ?? "");
  if (safeAvatarURL) {
    return (
      <Image
        source={{ uri: safeAvatarURL }}
        style={{ width: size, height: size, borderRadius: Math.max(10, size / 3) }}
      />
    );
  }

  return <Text style={textStyle}>{initials(displayName)}</Text>;
}

function normalizeAvatarURL(value: string) {
  const trimmed = value.trim();
  if (trimmed.length > 512) return "";
  return trimmed.startsWith("https://") ? trimmed : "";
}

function callParticipantLabel(mode: "voice" | "video", remoteParticipantCount: number) {
  const media = mode === "video" ? "Camera and microphone are on" : "Microphone is on";
  if (remoteParticipantCount === 0) {
    return `${media}. Waiting for the other person.`;
  }
  if (remoteParticipantCount === 1) {
    return `${media}. 1 other person connected.`;
  }
  return `${media}. ${remoteParticipantCount} others connected.`;
}

function directRoomID(firstID: string, secondID: string) {
  return `dm:${[firstID, secondID].sort().join(":")}`;
}

function isDirectRoomID(roomID: string) {
  return directMessageRecipients(roomID).length === 2;
}

function directMessageRecipients(roomID: string) {
  const parts = roomID.split(":");
  return parts.length === 3 && parts[0] === "dm" && parts[1] && parts[2] ? parts.slice(1) : [];
}

function normalizeIncomingCallPayload(data: unknown): IncomingCallPayload | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;
  const roomId = typeof payload.roomId === "string" ? payload.roomId.trim() : "";
  const senderId = typeof payload.senderId === "string" ? payload.senderId.trim() : "";
  const sender = typeof payload.sender === "string" ? payload.sender.trim() : "";
  const callId = typeof payload.callId === "string" && payload.callId.trim() ? payload.callId.trim() : `${roomId}:${senderId}`;
  const mode = payload.mode === "video" ? "video" : "voice";
  const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : undefined;
  if (!roomId || !senderId || !sender) return null;
  return { callId, roomId, senderId, sender, mode, expiresAt };
}

function parseNativeCallURL(url: string | null): { action: "accept" | "decline"; payload: IncomingCallPayload } | null {
  if (!url?.startsWith("phonelevelg://call?")) return null;
  const query = url.slice("phonelevelg://call?".length);
  const params = query.split("&").reduce<Record<string, string>>((current, part) => {
    const [rawKey, rawValue = ""] = part.split("=");
    if (!rawKey) return current;
    current[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, " "));
    return current;
  }, {});
  if (params.action !== "accept" && params.action !== "decline") return null;

  const payload = normalizeIncomingCallPayload(params);
  if (!payload) return null;
  return { action: params.action, payload };
}

function isExpiredCall(expiresAt?: string) {
  if (!expiresAt) return false;
  const expirationTime = Date.parse(expiresAt);
  return Number.isFinite(expirationTime) && expirationTime <= Date.now();
}

function callMatchesPayload(call: IncomingCall, payload: { callId?: string; roomId: string }) {
  return Boolean(payload.callId && payload.callId === call.callId) || payload.roomId === call.roomId;
}

function createCallUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, value => {
    const random = Math.floor(Math.random() * 16);
    const digit = value === "x" ? random : (random & 0x3) | 0x8;
    return digit.toString(16);
  });
}

function supportsNativePushRegistration() {
  return Platform.OS === "ios" || Platform.OS === "android";
}

async function getPersistentDeviceID() {
  const storedDeviceID = await AsyncStorage.getItem(STORED_DEVICE_ID_KEY);
  if (storedDeviceID) return storedDeviceID;

  const nextDeviceID = `${Platform.OS}-${createCallUUID()}`;
  await AsyncStorage.setItem(STORED_DEVICE_ID_KEY, nextDeviceID);
  return nextDeviceID;
}

async function getPersistentVoIPDeviceID() {
  const deviceID = await getPersistentDeviceID();
  return `${deviceID}:voip`;
}

function pushTokenTypeForPlatform(type: string) {
  if (type === "ios") return "apns";
  if (type === "android") return "fcm";
  return "expo";
}

function serializePushTokenData(data: unknown) {
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}

async function registerDeviceForPush(nextSession: Session, apiURL: string) {
  if (E2E_MODE || !supportsNativePushRegistration()) return;

  await registerVoIPDeviceForPush(nextSession, apiURL).catch(() => undefined);

  try {
    await requestIncomingCallNotificationPermission();

    const devicePushToken = await Notifications.getDevicePushTokenAsync();
    const pushToken = serializePushTokenData(devicePushToken.data);
    if (!pushToken) return;

    await fetch(`${apiURL}/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: nextSession.userId,
        deviceId: await getPersistentDeviceID(),
        platform: Platform.OS,
        pushToken,
        pushTokenType: pushTokenTypeForPlatform(devicePushToken.type),
        appVersion: "0.1.0"
      })
    });
  } catch {
    // Push registration is retried after login restore and token rotation.
  }
}

async function requestIncomingCallNotificationPermission() {
  const currentPermissions = await Notifications.getPermissionsAsync();
  if (!currentPermissions.granted) {
    await Notifications.requestPermissionsAsync();
  }
}

async function registerVoIPDeviceForPush(nextSession: Session, apiURL: string) {
  if (Platform.OS !== "ios" || !nativeVoIPTokenModule?.getToken) return;

  const pushToken = await nativeVoIPTokenModule.getToken();
  if (!pushToken) return;

  await fetch(`${apiURL}/devices/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: nextSession.userId,
      deviceId: await getPersistentVoIPDeviceID(),
      platform: "ios",
      pushToken,
      pushTokenType: "apns-voip",
      appVersion: "0.1.0"
    })
  });
}

async function unregisterDeviceForPush(nextSession: Session, apiURL: string) {
  if (E2E_MODE || !supportsNativePushRegistration()) return;

  try {
    const deviceID = await AsyncStorage.getItem(STORED_DEVICE_ID_KEY);
    if (!deviceID) return;

    await fetch(`${apiURL}/devices/${encodeURIComponent(deviceID)}?userId=${encodeURIComponent(nextSession.userId)}`, {
      method: "DELETE"
    });
    if (Platform.OS === "ios") {
      await unregisterVoIPDeviceForPush(nextSession, apiURL, deviceID);
    }
  } catch {
    // Logout must continue even if the backend cannot remove the stale token.
  }
}

async function unregisterVoIPDeviceForPush(nextSession: Session, apiURL: string, deviceID: string) {
  await fetch(`${apiURL}/devices/${encodeURIComponent(`${deviceID}:voip`)}?userId=${encodeURIComponent(nextSession.userId)}`, {
    method: "DELETE"
  }).catch(() => undefined);
}

function normalizeServerURL(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_API_URL;
  return trimmed.replace(/\/+$/, "");
}

async function requestCallPermissions(mode: "voice" | "video") {
  if (Platform.OS === "ios") {
    const micPermission = await requestRecordingPermissionsAsync();
    if (!micPermission.granted) {
      return false;
    }
    if (mode === "video") {
      return requestIOSCameraPermission();
    }
    return true;
  }

  if (Platform.OS !== "android") {
    return true;
  }

  const permissions = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (mode === "video") {
    permissions.push(PermissionsAndroid.PERMISSIONS.CAMERA);
  }

  const results = await PermissionsAndroid.requestMultiple(permissions);

  return Object.values(results).every(result => result === PermissionsAndroid.RESULTS.GRANTED);
}

async function requestIOSCameraPermission() {
  const mediaDevices = (globalThis as unknown as {
    navigator?: {
      mediaDevices?: {
        getUserMedia?: (constraints: { video: boolean; audio: boolean }) => Promise<{ getTracks?: () => Array<{ stop?: () => void }> }>;
      };
    };
  }).navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    return false;
  }

  let stream: { getTracks?: () => Array<{ stop?: () => void }> } | undefined;
  try {
    stream = await mediaDevices.getUserMedia({ video: true, audio: false });
    return true;
  } catch {
    return false;
  } finally {
    stream?.getTracks?.().forEach(track => track.stop?.());
  }
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: "#0f1720"
  },
  loginHero: {
    paddingHorizontal: 24,
    paddingTop: 64 + TOP_SAFE_AREA_HEIGHT,
    paddingBottom: 28,
    backgroundColor: "#0f1720"
  },
  logoMark: {
    width: 58,
    height: 58,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: "#7c3aed",
    marginBottom: 22
  },
  logoImage: {
    width: 58,
    height: 58
  },
  loginPanel: {
    flex: 1,
    gap: 12,
    padding: 24,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: "#f7f3ff"
  },
  title: {
    fontSize: 34,
    fontWeight: "800",
    color: "#f8fafc"
  },
  subtitle: {
    maxWidth: 320,
    marginTop: 8,
    fontSize: 16,
    lineHeight: 22,
    color: "#b7c1cc"
  },
  input: {
    minHeight: 54,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd1ff",
    backgroundColor: "#ffffff",
    paddingHorizontal: 15,
    fontSize: 17,
    color: "#141b24"
  },
  googleAccountBox: {
    minHeight: 72,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd1ff",
    backgroundColor: "#ffffff",
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  googleGMark: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e2e8f0"
  },
  googleGText: {
    color: "#4285f4",
    fontSize: 24,
    fontWeight: "900"
  },
  googleAccountText: {
    flex: 1,
    minWidth: 0
  },
  googleAccountTitle: {
    color: "#24123d",
    fontSize: 16,
    fontWeight: "800"
  },
  googleAccountSubtitle: {
    marginTop: 3,
    color: "#5b6472",
    fontSize: 13,
    fontWeight: "600"
  },
  accountPill: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#c4b5fd",
    backgroundColor: "#ede9fe",
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  accountPillLabel: {
    color: "#6d28d9",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  accountPillText: {
    marginTop: 2,
    color: "#24123d",
    fontSize: 15,
    fontWeight: "700"
  },
  loginHint: {
    color: "#5b6472",
    fontSize: 13,
    lineHeight: 18
  },
  primaryButton: {
    minHeight: 54,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#7c3aed"
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "800"
  },
  chatLayout: {
    flex: 1,
    backgroundColor: "#eee9ff"
  },
  fullScreenCall: {
    flex: 1,
    backgroundColor: "#000000"
  },
  fullScreenVideoFrame: {
    flex: 1,
    backgroundColor: "#000000"
  },
  fullScreenVoiceFrame: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#10131a"
  },
  fullScreenVideoPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#140a24"
  },
  fullScreenVideoWaitingAvatar: {
    width: 116,
    height: 116,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: "#d8ccff",
    marginBottom: 18
  },
  fullScreenVideoWaitingName: {
    maxWidth: "78%",
    color: "#ffffff",
    fontSize: 30,
    fontWeight: "900",
    textAlign: "center"
  },
  fullScreenVideoWaitingStatus: {
    color: "#d8ccff",
    fontSize: 16,
    fontWeight: "800",
    marginTop: 8
  },
  fullScreenCallHeader: {
    position: "absolute",
    top: TOP_SAFE_AREA_HEIGHT + 14,
    left: 18,
    right: 18,
    minHeight: 58,
    borderRadius: 18,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(15, 23, 32, 0.72)"
  },
  fullScreenPeerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#d8ccff",
    overflow: "hidden"
  },
  fullScreenPeerAvatarText: {
    color: "#24123d",
    fontSize: 15,
    fontWeight: "900"
  },
  fullScreenPeerText: {
    flex: 1,
    minWidth: 0
  },
  fullScreenCallingText: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "900"
  },
  fullScreenStatusText: {
    color: "#d1d5db",
    fontSize: 13,
    fontWeight: "700",
    marginTop: 2
  },
  fullScreenLocalVideoFrame: {
    position: "absolute",
    right: 16,
    bottom: 126,
    width: 116,
    height: 162,
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "#ffffff",
    backgroundColor: "#111827"
  },
  fullScreenFlipCameraButton: {
    position: "absolute",
    left: 24,
    bottom: 46,
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15, 23, 32, 0.72)"
  },
  fullScreenHangupButton: {
    position: "absolute",
    alignSelf: "center",
    bottom: 34,
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#dc2626"
  },
  voiceAvatar: {
    width: 118,
    height: 118,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: "#d8ccff"
  },
  voiceAvatarText: {
    color: "#24123d",
    fontSize: 38,
    fontWeight: "900"
  },
  header: {
    minHeight: 76 + TOP_SAFE_AREA_HEIGHT,
    paddingHorizontal: 16,
    paddingTop: 10 + TOP_SAFE_AREA_HEIGHT,
    paddingBottom: 10,
    backgroundColor: "#0f1720",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  identity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#c4b5fd"
  },
  avatarText: {
    color: "#24123d",
    fontWeight: "900"
  },
  presence: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "#0f1720"
  },
  online: {
    backgroundColor: "#33c179"
  },
  offline: {
    backgroundColor: "#8a95a3"
  },
  roomTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#f8fafc",
    maxWidth: "100%"
  },
  status: {
    fontSize: 13,
    color: "#b7c1cc",
    marginTop: 2
  },
  headerActions: {
    flexDirection: "row",
    gap: 6,
    marginLeft: 8
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3c245f"
  },
  secondaryIconButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#24123d",
    borderWidth: 1,
    borderColor: "#6d46a3"
  },
  headerButtonActive: {
    backgroundColor: "#6d28d9",
    borderColor: "#8b5cf6"
  },
  headerBadge: {
    position: "absolute",
    right: -4,
    top: -5,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    overflow: "hidden",
    paddingHorizontal: 4,
    textAlign: "center",
    textAlignVertical: "center",
    color: "#24123d",
    backgroundColor: "#f8fafc",
    fontSize: 10,
    fontWeight: "900"
  },
  menuOverlay: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: TOP_SAFE_AREA_HEIGHT + 76,
    backgroundColor: "rgba(15, 23, 32, 0.38)"
  },
  optionsMenuSheet: {
    gap: 10,
    alignSelf: "flex-end",
    width: "100%",
    maxWidth: 390,
    borderRadius: 16,
    padding: 12,
    backgroundColor: "#140a24",
    borderWidth: 1,
    borderColor: "#2f1b4b",
    shadowColor: "#000000",
    shadowOpacity: 0.24,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12
  },
  contactsMenuSheet: {
    alignSelf: "flex-end",
    width: "100%",
    maxWidth: 430,
    borderRadius: 16,
    paddingVertical: 12,
    backgroundColor: "#f7f3ff",
    borderWidth: 1,
    borderColor: "#ded4ff",
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12
  },
  menuHeader: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  menuTitle: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "900"
  },
  optionsSectionHeader: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10
  },
  optionsSectionTitle: {
    color: "#f8fafc",
    fontSize: 13,
    fontWeight: "900"
  },
  permissionStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#140a24"
  },
  permissionToggle: {
    flex: 1,
    minWidth: 0,
    minHeight: 38,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 8,
    backgroundColor: "#24123d",
    borderWidth: 1,
    borderColor: "#4c2c73"
  },
  permissionToggleOn: {
    backgroundColor: "#33c179",
    borderColor: "#33c179"
  },
  permissionToggleDenied: {
    borderColor: "#dc2626"
  },
  permissionToggleText: {
    flexShrink: 1,
    color: "#f8fafc",
    fontSize: 12,
    fontWeight: "800"
  },
  permissionToggleTextOn: {
    color: "#062a1a"
  },
  permissionStateText: {
    color: "#b7c1cc",
    fontSize: 11,
    fontWeight: "800"
  },
  permissionStateTextOn: {
    color: "#062a1a"
  },
  permissionSettingsButton: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3c245f",
    borderWidth: 1,
    borderColor: "#6d46a3"
  },
  messageSoundToggle: {
    minHeight: 44,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    backgroundColor: "#ebe7ff"
  },
  messageSoundToggleText: {
    flex: 1,
    color: "#24123d",
    fontSize: 13,
    fontWeight: "800"
  },
  messageSoundToggleTextOn: {
    color: "#062a1a"
  },
  messageSoundSwitch: {
    width: 44,
    height: 24,
    borderRadius: 12,
    padding: 3,
    backgroundColor: "#7c8794"
  },
  messageSoundSwitchOn: {
    backgroundColor: "#33c179"
  },
  messageSoundKnob: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#ffffff"
  },
  messageSoundKnobOn: {
    transform: [{ translateX: 20 }]
  },
  optionLogoutButton: {
    minHeight: 42,
    borderRadius: 12,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#3c245f",
    borderWidth: 1,
    borderColor: "#6d46a3"
  },
  optionLogoutText: {
    color: "#f8fafc",
    fontSize: 13,
    fontWeight: "900"
  },
  incomingCallOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 10,
    paddingHorizontal: 28,
    paddingTop: 78 + TOP_SAFE_AREA_HEIGHT,
    paddingBottom: 46,
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#24123d",
    shadowColor: "#000000",
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12
  },
  incomingCallContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    width: "100%"
  },
  incomingPulse: {
    width: 104,
    height: 104,
    borderRadius: 52,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#7c3aed",
    marginBottom: 28
  },
  incomingLabel: {
    color: "#d8ccff",
    fontSize: 14,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  incomingName: {
    color: "#ffffff",
    fontSize: 36,
    fontWeight: "900",
    marginTop: 10,
    textAlign: "center"
  },
  incomingHint: {
    color: "#c4b5fd",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 10
  },
  incomingActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "74%",
    maxWidth: 310
  },
  callActionButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center"
  },
  declineButton: {
    backgroundColor: "#dc2626"
  },
  acceptButton: {
    backgroundColor: "#16a34a"
  },
  videoCallStage: {
    marginHorizontal: 12,
    marginTop: 12,
    height: 260,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#140a24"
  },
  remoteVideoFrame: {
    flex: 1,
    backgroundColor: "#140a24"
  },
  videoView: {
    flex: 1
  },
  videoPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#24123d"
  },
  videoPlaceholderTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
    marginTop: 12
  },
  videoPlaceholderText: {
    color: "#c4b5fd",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 4
  },
  localVideoFrame: {
    position: "absolute",
    right: 12,
    bottom: 12,
    width: 108,
    height: 148,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "#ffffff",
    backgroundColor: "#7c3aed"
  },
  localVideoFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#7c3aed"
  },
  flipCameraButton: {
    position: "absolute",
    left: 12,
    bottom: 12,
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(36, 18, 61, 0.88)"
  },
  callBanner: {
    margin: 12,
    marginBottom: 0,
    borderRadius: 14,
    padding: 14,
    backgroundColor: "#2f1b4c",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  callTitle: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "800"
  },
  callMeta: {
    color: "#b7c1cc",
    fontSize: 13,
    marginTop: 2
  },
  hangupButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#c9413a"
  },
  lobby: {
    paddingTop: 10,
    paddingBottom: 8,
    backgroundColor: "#f7f3ff",
    borderBottomWidth: 1,
    borderBottomColor: "#ded4ff"
  },
  lobbyHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    marginBottom: 8
  },
  lobbyTitle: {
    color: "#141b24",
    fontSize: 14,
    fontWeight: "900"
  },
  lobbyCount: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    overflow: "hidden",
    textAlign: "center",
    textAlignVertical: "center",
    color: "#ffffff",
    backgroundColor: "#7c3aed",
    fontSize: 12,
    fontWeight: "900"
  },
  memberList: {
    gap: 8,
    paddingHorizontal: 14
  },
  memberChip: {
    width: 150,
    minHeight: 54,
    borderRadius: 14,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e1d8ff"
  },
  memberChipMine: {
    borderColor: "#b9a6f8",
    backgroundColor: "#f0ebff"
  },
  memberChipSelected: {
    borderColor: "#7c3aed",
    backgroundColor: "#ede6ff"
  },
  privateChatActions: {
    marginTop: 8,
    marginHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap"
  },
  homeRoomButton: {
    alignSelf: "flex-start",
    minHeight: 34,
    borderRadius: 11,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#24123d"
  },
  homeRoomText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900"
  },
  deleteChatButton: {
    minHeight: 34,
    borderRadius: 11,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#ffedd5",
    borderWidth: 1,
    borderColor: "#fdba74"
  },
  deleteChatText: {
    color: "#7c2d12",
    fontSize: 12,
    fontWeight: "900"
  },
  memberAvatar: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#24123d"
  },
  memberAvatarText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900"
  },
  memberName: {
    maxWidth: 86,
    color: "#141b24",
    fontSize: 13,
    fontWeight: "900"
  },
  memberMeta: {
    marginTop: 2,
    color: "#596575",
    fontSize: 11,
    fontWeight: "700"
  },
  unreadDot: {
    position: "absolute",
    right: 8,
    top: 8,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: "#7c3aed"
  },
  messages: {
    padding: 14,
    gap: 12
  },
  messageGroup: {
    maxWidth: "82%"
  },
  groupMine: {
    alignSelf: "flex-end",
    alignItems: "flex-end"
  },
  groupTheirs: {
    alignSelf: "flex-start",
    alignItems: "flex-start"
  },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 10,
    shadowColor: "#000000",
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1
  },
  mine: {
    borderBottomRightRadius: 5,
    backgroundColor: "#e9ddff"
  },
  theirs: {
    borderBottomLeftRadius: 5,
    backgroundColor: "#fffdf8"
  },
  sender: {
    color: "#596575",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 4,
    marginLeft: 4
  },
  senderMine: {
    marginLeft: 0,
    marginRight: 4,
    color: "#6d28d9"
  },
  messageText: {
    color: "#141b24",
    fontSize: 17,
    lineHeight: 23
  },
  attachmentCard: {
    width: 230,
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 10
  },
  attachmentImagePreview: {
    width: 92,
    height: 92,
    borderRadius: 10,
    backgroundColor: "#f3e8ff"
  },
  attachmentIcon: {
    width: 42,
    height: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f3e8ff"
  },
  attachmentTextBlock: {
    flex: 1,
    minWidth: 0
  },
  attachmentName: {
    color: "#141b24",
    fontSize: 15,
    fontWeight: "800"
  },
  attachmentMeta: {
    color: "#596575",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 2
  },
  timestamp: {
    color: "#77808b",
    fontSize: 11,
    marginTop: 4,
    marginHorizontal: 4
  },
  emojiRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
    backgroundColor: "#f7f3ff",
    borderTopWidth: 1,
    borderTopColor: "#ded4ff"
  },
  emojiLead: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ebe4ff"
  },
  emojiButton: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff"
  },
  catMemeIconButton: {
    borderWidth: 1,
    borderColor: "#ddd1ff"
  },
  catMemeIconButtonOpen: {
    backgroundColor: "#ede6ff",
    borderColor: "#7c3aed"
  },
  emoji: {
    fontSize: 22
  },
  catMemeRow: {
    flexGrow: 0,
    flexShrink: 0,
    height: 56,
    backgroundColor: "#f7f3ff",
    borderTopWidth: 1,
    borderTopColor: "#e5dcff"
  },
  catMemeList: {
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: "center"
  },
  catMemeButton: {
    height: 40,
    borderRadius: 13,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#ddd1ff"
  },
  catMemeIcon: {
    fontSize: 18
  },
  catMemeLabel: {
    color: "#24123d",
    fontSize: 13,
    fontWeight: "900",
    textTransform: "capitalize"
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 10,
    gap: 8,
    backgroundColor: "#f7f3ff"
  },
  attachButton: {
    width: 42,
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#ddd1ff"
  },
  messageInput: {
    flex: 1,
    minHeight: 46,
    maxHeight: 118,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ddd1ff",
    backgroundColor: "#ffffff",
    paddingHorizontal: 13,
    paddingVertical: 10,
    fontSize: 17,
    color: "#141b24"
  },
  sendButton: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#7c3aed"
  },
  disabledButton: {
    opacity: 0.45
  }
});
