import "react-native-get-random-values";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import * as AuthSession from "expo-auth-session";
import { setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import * as Notifications from "expo-notifications";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  LogBox,
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
import { LogLevel, Room, RoomEvent, isVideoTrack, setLogLevel, type VideoTrack as LiveKitVideoTrack } from "livekit-client";
import {
  Phone,
  PhoneOff,
  LogOut,
  SendHorizontal,
  Mail,
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

const NativeRTCView = Platform.OS === "web"
  ? undefined
  : (require("@livekit/react-native-webrtc") as { RTCView: ComponentType<any> }).RTCView;
const registerLiveKitGlobals = Platform.OS === "web"
  ? undefined
  : (require("@livekit/react-native") as { registerGlobals: () => void }).registerGlobals;
let cachedNativeCallKeep: any | null | undefined;

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
const GOOGLE_CLIENT_ID =
  Platform.OS === "ios"
    ? process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
    : Platform.OS === "android"
      ? process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
      : process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const GOOGLE_DISCOVERY = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  userInfoEndpoint: "https://www.googleapis.com/oauth2/v3/userinfo"
};
const ROOM_ID = "home";
const E2E_MODE = process.env.EXPO_PUBLIC_E2E_MODE === "1";
const STORED_SESSION_KEY = "phone-levelg.session.v2";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INCOMING_CALL_CHANNEL_ID = "incoming-calls";
const DEFAULT_RINGTONE_SOUND = "rockstar.mp3";
const ANDROID_STATUS_BAR_HEIGHT = Platform.OS === "android" ? NativeStatusBar.currentHeight ?? 0 : 0;
const IOS_STATUS_BAR_HEIGHT = Platform.OS === "ios" ? 44 : 0;
const TOP_SAFE_AREA_HEIGHT = ANDROID_STATUS_BAR_HEIGHT + IOS_STATUS_BAR_HEIGHT;

type Session = {
  userId: string;
  displayName: string;
  accountEmail: string;
  avatarURL?: string;
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
  createdAt: string;
};

type Member = {
  id: string;
  displayName: string;
  avatarURL?: string;
  createdAt?: string;
  lastSeenAt: string;
};

type IncomingCall = {
  callUUID: string;
  roomId: string;
  sender: string;
  mode: "voice" | "video";
};

type CallPeer = {
  displayName: string;
  avatarURL?: string;
};

type SocketEvent =
  | { type: "message:new"; data: Message }
  | { type: "message:clear"; data: { roomId: string; senderId: string } }
  | { type: "call:ring"; data: { roomId: string; senderId: string; sender: string; mode?: "voice" | "video" } }
  | { type: "call:end"; data: { roomId: string; senderId: string; sender: string } }
  | { type: "call:reject"; data: { roomId: string; senderId: string; sender: string } }
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
      responseType: AuthSession.ResponseType.Token,
      scopes: ["openid", "profile", "email"],
      extraParams: { prompt: "select_account" }
    },
    GOOGLE_DISCOVERY
  );
  const [session, setSession] = useState<Session | null>(
    E2E_MODE && e2eScreen !== "login"
      ? { userId: "e2e-user", displayName: "Carlos", accountEmail: "carlos@example.test" }
      : null
  );
  const [displayName, setDisplayName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [avatarURL, setAvatarURL] = useState("");
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
  const [connected, setConnected] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState("Ready");
  const [remoteParticipantCount, setRemoteParticipantCount] = useState(0);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [unreadRoomIDs, setUnreadRoomIDs] = useState<string[]>([]);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [callMode, setCallMode] = useState<"voice" | "video">("voice");
  const [callPeer, setCallPeer] = useState<CallPeer | null>(null);
  const [localVideoTrack, setLocalVideoTrack] = useState<LiveKitVideoTrack | undefined>();
  const [remoteVideoTrack, setRemoteVideoTrack] = useState<LiveKitVideoTrack | undefined>();
  const [cameraDeviceID, setCameraDeviceID] = useState<string | undefined>();
  const socketRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<Room | null>(null);
  const activeCallRoomIDRef = useRef<string | null>(null);
  const activeCallUUIDRef = useRef<string | null>(null);
  const incomingCallRef = useRef<IncomingCall | null>(null);
  const nativeCallsRef = useRef<Record<string, IncomingCall>>({});
  const callKeepReadyRef = useRef(false);
  const incomingCallNotificationRef = useRef<string | null>(null);
  const apiURL = useMemo(() => normalizeServerURL(serverURL), [serverURL]);
  const googleAuthConfigured = Boolean(GOOGLE_CLIENT_ID);

  const activeRoomID = useMemo(() => {
    if (!session || !selectedMember) return ROOM_ID;
    return directRoomID(session.userId, selectedMember.id);
  }, [selectedMember, session]);
  const activeRoomTitle = selectedMember?.displayName ?? "Home";
  const headerTitle = session ? `${activeRoomTitle} - ${session.displayName}` : activeRoomTitle;
  const canSend = useMemo(() => draft.trim().length > 0 && session && connected, [draft, session, connected]);
  const callPeerName = callPeer?.displayName ?? activeRoomTitle;
  const isFullScreenCall = callActive;

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    if (E2E_MODE) return;
    void restoreStoredSession();
  }, []);

  useEffect(() => {
    const nativeCallKeep = getNativeCallKeep();
    if (E2E_MODE || !nativeCallKeep) return;
    const listeners = [
      nativeCallKeep.addEventListener("answerCall", ({ callUUID }: { callUUID: string }) => {
        void acceptNativeIncomingCall(callUUID);
      }),
      nativeCallKeep.addEventListener("endCall", ({ callUUID }: { callUUID: string }) => {
        void endNativeCall(callUUID);
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
      // The in-app call sheet and system notification remain as fallback.
    }
  }

  async function acceptNativeIncomingCall(callUUID: string) {
    const call = nativeCallsRef.current[callUUID] ?? incomingCallRef.current;
    if (!call) return;

    activeCallUUIDRef.current = callUUID;
    setIncomingCall(null);
    incomingCallRef.current = null;
    await joinCall(call.mode, call.roomId, false);
    getNativeCallKeep()?.setCurrentCallActive?.(callUUID);
  }

  async function endNativeCall(callUUID: string) {
    const call = nativeCallsRef.current[callUUID];
    delete nativeCallsRef.current[callUUID];

    if (activeCallUUIDRef.current === callUUID) {
      await endCurrentCall({ announce: true, status: "Call ended", native: false });
      return;
    }

    if (incomingCallRef.current?.callUUID === callUUID || call) {
      await declineIncomingCall({ announce: true });
    }
  }

  async function restoreStoredSession() {
    try {
      const stored = await AsyncStorage.getItem(STORED_SESSION_KEY);
      if (!stored) return;

      const payload = JSON.parse(stored) as StoredSession;
      if (!payload.session?.userId || payload.expiresAt <= Date.now()) {
        await AsyncStorage.removeItem(STORED_SESSION_KEY);
        return;
      }

      setServerURL(payload.serverURL || DEFAULT_API_URL);
      setInviteCode(payload.inviteCode || "home");
      setDisplayName(payload.session.displayName);
      setAccountEmail(payload.session.accountEmail);
      setAvatarURL(payload.session.avatarURL ?? "");
      setSession(payload.session);
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
    if (!accessToken) {
      Alert.alert("Google sign-in failed", "Google did not return an access token.");
      return;
    }

    void loadGoogleAccount(accessToken);
  }, [googleResponse]);

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
        return;
      }

      setAccountEmail(email);
      setAvatarURL(normalizeAvatarURL(profile.picture ?? ""));
      setDisplayName(current => current.trim() || profile.name?.trim() || email.split("@")[0]);
    } catch {
      Alert.alert("Google sign-in failed", "Could not read the Google account email.");
    }
  }

  async function refreshMessages(roomID = activeRoomID, userID = session?.userId) {
    if (!userID) return;
    try {
      const payload = await fetchJSON(`${apiURL}/rooms/${encodeURIComponent(roomID)}/messages?userId=${encodeURIComponent(userID)}`);
      const nextMessages = (payload.messages ?? []) as Message[];
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
        if (payload.data.roomId === activeRoomID) {
          setMessages(current => mergeMessages(current, payload.data));
        } else {
          setUnreadRoomIDs(current => current.includes(payload.data.roomId) ? current : [...current, payload.data.roomId]);
          void refreshMembers();
        }
      }
      if (payload.type === "message:clear") {
        setUnreadRoomIDs(current => current.filter(roomID => roomID !== payload.data.roomId));
        if (payload.data.roomId === activeRoomID) {
          setMessages([]);
          setSelectedMember(null);
        }
      }
      if (payload.type === "call:ring" && payload.data.senderId !== session.userId) {
        const ringMode = payload.data.mode === "video" ? "video" : "voice";
        const callUUID = createCallUUID();
        const nextCall: IncomingCall = { callUUID, roomId: payload.data.roomId, sender: payload.data.sender, mode: ringMode };
        nativeCallsRef.current[callUUID] = nextCall;
        setCallPeer({ displayName: payload.data.sender });
        setIncomingCall(nextCall);
        void displayNativeIncomingCall(nextCall);
        void startIncomingCallTone();
      }
      if (payload.type === "call:end" && payload.data.senderId !== session.userId) {
        if (incomingCallRef.current?.roomId === payload.data.roomId) {
          void declineIncomingCall({ announce: false });
        }
        if (activeCallRoomIDRef.current === payload.data.roomId) {
          void endCurrentCall({ announce: false, status: "Call ended" });
        }
      }
      if (payload.type === "call:reject" && payload.data.senderId !== session.userId) {
        if (incomingCallRef.current?.roomId === payload.data.roomId) {
          void declineIncomingCall({ announce: false });
        }
        if (activeCallRoomIDRef.current === payload.data.roomId) {
          void endCurrentCall({ announce: false, status: "Call rejected" });
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

  async function login() {
    const nextAccountEmail = accountEmail.trim().toLowerCase();
    const nextDisplayName = (displayName.trim() || nextAccountEmail.split("@")[0] || "LevelG").slice(0, 40);

    if (E2E_MODE) {
      setSession({ userId: "e2e-user", displayName: nextDisplayName || "Carlos", accountEmail: nextAccountEmail || "carlos@example.test", avatarURL });
      setConnected(true);
      return;
    }

    if (!nextAccountEmail || !nextAccountEmail.includes("@")) {
      Alert.alert("Google email required", "Sign in with Google or enter the Google email for this account.");
      return;
    }

    try {
      const response = await fetch(`${apiURL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: nextDisplayName, accountEmail: nextAccountEmail, avatarURL: normalizeAvatarURL(avatarURL), inviteCode })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        Alert.alert("Login failed", `Server returned ${response.status}. Check the server URL and secret.${errorText ? `\n\n${errorText.slice(0, 180)}` : ""}`);
        return;
      }

      const nextSession = await response.json() as Session;
      setSession(nextSession);
      await persistSession(nextSession, apiURL, inviteCode.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      Alert.alert("Server unreachable", `Could not connect to ${apiURL}.\n\n${message}`);
    }
  }

  async function logout() {
    await endCurrentCall({ announce: true, status: "Ready" }).catch(() => undefined);
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

  function sendSocket(type: string, data: unknown) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type, data }));
  }

  async function sendMessage(text = draft) {
    if (!session || !text.trim()) return;
    const nextText = text.trim();
    try {
      const payload = await fetchJSON(`${apiURL}/rooms/${encodeURIComponent(activeRoomID)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderId: session.userId,
          displayName: session.displayName,
          text: nextText
        })
      });
      setMessages(current => mergeMessages(current, payload.message));
      setDraft("");
    } catch {
      Alert.alert("Message not sent", "The server did not save this message. Check the connection and try again.");
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
          sendSocket("call:ring", { roomId: roomID, mode });
        }
        if (activeCallUUIDRef.current) {
          getNativeCallKeep()?.reportConnectedOutgoingCallWithUUID?.(activeCallUUIDRef.current);
          getNativeCallKeep()?.setCurrentCallActive?.(activeCallUUIDRef.current);
        }
      });
      room.on(RoomEvent.ParticipantConnected, () => {
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
          const cameraPublication = await room.localParticipant.setCameraEnabled(true, { facingMode: "user" });
          if (isVideoTrack(cameraPublication?.track)) {
            setLocalVideoTrack(cameraPublication.track);
          }
          await loadCameraDevice(room);
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

  async function endCurrentCall({ announce, status, native = true }: { announce: boolean; status: string; native?: boolean }) {
    await stopIncomingCallTone();
    const roomID = activeCallRoomIDRef.current;
    const callUUID = activeCallUUIDRef.current;
    if (announce && roomID) {
      sendSocket("call:end", { roomId: roomID });
    }
    if (native && callUUID) {
      getNativeCallKeep()?.endCall(callUUID);
    }
    const room = roomRef.current;
    roomRef.current = null;
    activeCallRoomIDRef.current = null;
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
    setCameraDeviceID(undefined);
    setCallPeer(null);
    await resetAudioSession();
    setCallActive(false);
    setCallStatus(status);
    setRemoteParticipantCount(0);
  }

  async function declineIncomingCall(options: { announce?: boolean } = {}) {
    const call = incomingCallRef.current;
    if (options.announce !== false && call) {
      sendSocket("call:reject", { roomId: call.roomId });
      getNativeCallKeep()?.rejectCall(call.callUUID);
    }
    if (call) {
      delete nativeCallsRef.current[call.callUUID];
    }
    await stopIncomingCallTone();
    setIncomingCall(null);
    incomingCallRef.current = null;
    setCallPeer(null);
  }

  async function acceptIncomingCall() {
    if (!incomingCall) return;
    const nextCall = incomingCall;
    activeCallUUIDRef.current = nextCall.callUUID;
    setCallPeer({ displayName: nextCall.sender });
    setIncomingCall(null);
    await joinCall(nextCall.mode, nextCall.roomId, false);
    getNativeCallKeep()?.setCurrentCallActive?.(nextCall.callUUID);
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

  async function loadCameraDevice(room: Room) {
    const currentDevice = room.getActiveDevice("videoinput");
    if (currentDevice) {
      setCameraDeviceID(currentDevice);
      return;
    }
    const devices = await Room.getLocalDevices("videoinput", false).catch(() => []);
    setCameraDeviceID(devices[0]?.deviceId);
  }

  async function flipCamera() {
    const room = roomRef.current;
    if (!room || callMode !== "video") return;
    const devices = await Room.getLocalDevices("videoinput", true).catch(() => []);
    if (devices.length < 2) {
      Alert.alert("Camera unavailable", "This device did not report a second camera.");
      return;
    }

    const activeDeviceID = cameraDeviceID ?? room.getActiveDevice("videoinput") ?? devices[0]?.deviceId;
    const activeIndex = Math.max(0, devices.findIndex(device => device.deviceId === activeDeviceID));
    const nextDevice = devices[(activeIndex + 1) % devices.length];
    if (!nextDevice) return;

    try {
      setLocalVideoTrack(undefined);
      await room.switchActiveDevice("videoinput", nextDevice.deviceId);
      setCameraDeviceID(nextDevice.deviceId);
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
            disabled={!googleAuthConfigured || !googleRequest}
            style={[styles.googleButton, (!googleAuthConfigured || !googleRequest) && styles.disabledButton]}
            onPress={() => void promptGoogleSignIn()}
          >
            <Mail color={googleAuthConfigured ? "#24123d" : "#7c8794"} size={20} />
            <Text style={styles.googleButtonText}>
              {googleAuthConfigured ? "Sign in with Google" : "Configure Google OAuth client ID"}
            </Text>
          </Pressable>
          {accountEmail && (
            <View style={styles.accountPill}>
              <Text style={styles.accountPillLabel}>Google account</Text>
              <Text style={styles.accountPillText} numberOfLines={1}>{accountEmail}</Text>
            </View>
          )}
          <TextInput
            value={accountEmail}
            onChangeText={setAccountEmail}
            placeholder="Google email"
            placeholderTextColor="#7c8794"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            style={styles.input}
          />
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Display name"
            placeholderTextColor="#7c8794"
            autoCapitalize="words"
            style={styles.input}
          />
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
            onSubmitEditing={login}
            secureTextEntry
            style={styles.input}
          />
          <Text style={styles.loginHint}>Default server: OpenShift. The Google email identifies the account; the server URL and secret choose the private backend.</Text>
          <Pressable style={styles.primaryButton} onPress={login}>
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
                <Video color="#d8ccff" size={36} />
                <Text style={styles.fullScreenPlaceholderText}>Waiting for video</Text>
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
              <Text style={styles.status}>{connected ? callStatus : "Offline"}</Text>
            </View>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log out"
              hitSlop={12}
              android_ripple={{ color: "#6d28d9", borderless: false }}
              style={styles.secondaryIconButton}
              onPress={() => void logout()}
            >
              <LogOut color="#f8fafc" size={19} />
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
              <Pressable style={[styles.callActionButton, styles.declineButton]} onPress={() => void declineIncomingCall()}>
                <PhoneOff color="#ffffff" size={24} />
              </Pressable>
              <Pressable style={[styles.callActionButton, styles.acceptButton]} onPress={acceptIncomingCall}>
                <Phone color="#ffffff" size={24} />
              </Pressable>
            </View>
          </View>
        )}

        <View style={styles.lobby}>
          <View style={styles.lobbyHeader}>
            <Users color="#596575" size={17} />
            <Text style={styles.lobbyTitle}>Lobby</Text>
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
                  onPress={() => setSelectedMember(item)}
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

        <FlatList
          data={messages}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.messages}
          renderItem={({ item }) => {
            const mine = item.senderId === session.userId;
            return (
              <View style={[styles.messageGroup, mine ? styles.groupMine : styles.groupTheirs]}>
                <Text style={[styles.sender, mine && styles.senderMine]}>{mine ? "You" : item.sender}</Text>
                <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                  <Text style={styles.messageText}>{item.text}</Text>
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
        </View>

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
              onPress={() => sendMessage(item.text)}
            >
              <Text style={styles.catMemeIcon}>🐱</Text>
              <Text style={styles.catMemeLabel}>{item.label}</Text>
            </Pressable>
          )}
        />

        <View style={styles.composer}>
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
      member.lastSeenAt === other.lastSeenAt;
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

function createCallUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, value => {
    const random = Math.floor(Math.random() * 16);
    const digit = value === "x" ? random : (random & 0x3) | 0x8;
    return digit.toString(16);
  });
}

function normalizeServerURL(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_API_URL;
  return trimmed.replace(/\/+$/, "");
}

async function requestCallPermissions(mode: "voice" | "video") {
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
  googleButton: {
    minHeight: 54,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd1ff",
    backgroundColor: "#ffffff",
    paddingHorizontal: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10
  },
  googleButtonText: {
    color: "#24123d",
    fontSize: 16,
    fontWeight: "800"
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
  fullScreenPlaceholderText: {
    color: "#d8ccff",
    fontSize: 15,
    fontWeight: "800",
    marginTop: 12
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
    gap: 8,
    marginLeft: 10
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3c245f"
  },
  secondaryIconButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#24123d",
    borderWidth: 1,
    borderColor: "#6d46a3"
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
