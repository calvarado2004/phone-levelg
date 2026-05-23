import "react-native-get-random-values";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync, type AudioPlayer } from "expo-audio";
import { useEffect, useMemo, useRef, useState } from "react";
import { registerGlobals } from "@livekit/react-native";
import { RTCView } from "@livekit/react-native-webrtc";
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  PermissionsAndroid,
  Pressable,
  SafeAreaView,
  StyleSheet,
  StatusBar as NativeStatusBar,
  Text,
  TextInput,
  Vibration,
  View
} from "react-native";
import { Room, RoomEvent, isVideoTrack, type VideoTrack as LiveKitVideoTrack } from "livekit-client";
import {
  Phone,
  PhoneOff,
  SendHorizontal,
  Smile,
  SwitchCamera,
  Users,
  Video
} from "lucide-react-native";

registerGlobals();

declare const process: {
  env: Record<string, string | undefined>;
};

const DEFAULT_API_URL = Platform.OS === "android" ? "http://10.0.2.2:4000" : "http://localhost:4000";
const DEFAULT_LIVEKIT_URL = Platform.OS === "android" ? "ws://10.0.2.2:7880" : "ws://localhost:7880";
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_URL;
const LIVEKIT_URL = process.env.EXPO_PUBLIC_LIVEKIT_URL ?? DEFAULT_LIVEKIT_URL;
const ROOM_ID = "home";
const E2E_MODE = process.env.EXPO_PUBLIC_E2E_MODE === "1";
const ANDROID_STATUS_BAR_HEIGHT = Platform.OS === "android" ? NativeStatusBar.currentHeight ?? 0 : 0;

type Session = {
  userId: string;
  displayName: string;
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
  createdAt?: string;
  lastSeenAt: string;
};

type IncomingCall = {
  roomId: string;
  sender: string;
  mode: "voice" | "video";
};

type SocketEvent =
  | { type: "message:new"; data: Message }
  | { type: "call:ring"; data: { roomId: string; senderId: string; sender: string; mode?: "voice" | "video" } }
  | { type: "call:end"; data: { roomId: string; senderId: string; sender: string } }
  | { type: "call:reject"; data: { roomId: string; senderId: string; sender: string } }
  | { type: "member:joined"; data: Member };

const QUICK_EMOJIS = ["👍", "😂", "❤️", "🔥", "🎉", "👀"];

export default function App() {
  const e2eScreen = getQueryParam("screen");
  const [session, setSession] = useState<Session | null>(
    E2E_MODE && e2eScreen !== "login"
      ? { userId: "e2e-user", displayName: "Carlos" }
      : null
  );
  const [displayName, setDisplayName] = useState("");
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
  const [localVideoTrack, setLocalVideoTrack] = useState<LiveKitVideoTrack | undefined>();
  const [remoteVideoTrack, setRemoteVideoTrack] = useState<LiveKitVideoTrack | undefined>();
  const [cameraDeviceID, setCameraDeviceID] = useState<string | undefined>();
  const socketRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<Room | null>(null);
  const activeCallRoomIDRef = useRef<string | null>(null);
  const incomingCallRef = useRef<IncomingCall | null>(null);
  const ringtoneRef = useRef<AudioPlayer | null>(null);

  const activeRoomID = useMemo(() => {
    if (!session || !selectedMember) return ROOM_ID;
    return directRoomID(session.userId, selectedMember.id);
  }, [selectedMember, session]);
  const activeRoomTitle = selectedMember?.displayName ?? "Home";
  const canSend = useMemo(() => draft.trim().length > 0 && session && connected, [draft, session, connected]);
  const displayedVideoTrack = remoteVideoTrack ?? localVideoTrack;

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  async function refreshMessages(roomID = activeRoomID, userID = session?.userId) {
    if (!userID) return;
    try {
      const payload = await fetchJSON(`${API_URL}/rooms/${encodeURIComponent(roomID)}/messages?userId=${encodeURIComponent(userID)}`);
      const nextMessages = (payload.messages ?? []) as Message[];
      setMessages(current => messagesEqual(current, nextMessages) ? current : nextMessages);
    } catch {
      // Keep the existing view if a transient refresh fails.
    }
  }

  async function refreshMembers() {
    try {
      const payload = await fetchJSON(`${API_URL}/members`);
      const nextMembers = (payload.members ?? []) as Member[];
      setMembers(current => membersEqual(current, nextMembers) ? current : nextMembers);
    } catch {
      // Lobby refresh is opportunistic.
    }
  }

  async function refreshDirectInbox() {
    if (!session) return;
    try {
      const payload = await fetchJSON(`${API_URL}/direct/inbox?userId=${encodeURIComponent(session.userId)}`);
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

    const wsURL = `${API_URL.replace(/^http/, "ws")}/ws?roomId=${encodeURIComponent(activeRoomID)}&userId=${encodeURIComponent(session.userId)}&displayName=${encodeURIComponent(session.displayName)}`;
    const socket = new WebSocket(wsURL);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onerror = () => setConnected(false);
    socket.onmessage = event => {
      const payload = JSON.parse(event.data) as SocketEvent;
      if (payload.type === "message:new") {
        if (payload.data.roomId === activeRoomID) {
          setMessages(current => mergeMessages(current, payload.data));
        } else {
          setUnreadRoomIDs(current => current.includes(payload.data.roomId) ? current : [...current, payload.data.roomId]);
          void refreshMembers();
        }
      }
      if (payload.type === "call:ring" && payload.data.senderId !== session.userId) {
        const ringMode = payload.data.mode === "video" ? "video" : "voice";
        setIncomingCall({ roomId: payload.data.roomId, sender: payload.data.sender, mode: ringMode });
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

    return () => {
      socket.close();
      socketRef.current = null;
      void stopIncomingCallTone();
    };
  }, [activeRoomID, session]);

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
  }, [activeRoomID, selectedMember, session]);

  async function login() {
    if (E2E_MODE) {
      setSession({ userId: "e2e-user", displayName: displayName || "Carlos" });
      setConnected(true);
      return;
    }

    const response = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, inviteCode })
    });

    if (!response.ok) {
      Alert.alert("Login failed", "Check the invite code and server URL.");
      return;
    }

    setSession(await response.json());
  }

  function sendSocket(type: string, data: unknown) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type, data }));
  }

  async function sendMessage(text = draft) {
    if (!session || !text.trim()) return;
    const nextText = text.trim();
    try {
      const payload = await fetchJSON(`${API_URL}/rooms/${encodeURIComponent(activeRoomID)}/messages`, {
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

  async function joinCall(mode: "voice" | "video", roomID = activeRoomID, announce = true) {
    if (!session) return;
    await stopIncomingCallTone({ deactivateAudio: false });
    if (roomRef.current) {
      await endCurrentCall({ announce: false, status: "Switching call" });
    }
    activeCallRoomIDRef.current = roomID;
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

      const response = await fetch(`${API_URL}/calls/token`, {
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

  async function endCurrentCall({ announce, status }: { announce: boolean; status: string }) {
    await stopIncomingCallTone();
    const roomID = activeCallRoomIDRef.current;
    if (announce && roomID) {
      sendSocket("call:end", { roomId: roomID });
    }
    const room = roomRef.current;
    roomRef.current = null;
    activeCallRoomIDRef.current = null;
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
    await resetAudioSession();
    setCallActive(false);
    setCallStatus(status);
    setRemoteParticipantCount(0);
  }

  async function declineIncomingCall(options: { announce?: boolean } = {}) {
    const call = incomingCallRef.current;
    if (options.announce !== false && call) {
      sendSocket("call:reject", { roomId: call.roomId });
    }
    await stopIncomingCallTone();
    setIncomingCall(null);
    incomingCallRef.current = null;
  }

  async function acceptIncomingCall() {
    if (!incomingCall) return;
    const nextCall = incomingCall;
    setIncomingCall(null);
    await joinCall(nextCall.mode, nextCall.roomId, false);
  }

  async function startIncomingCallTone() {
    Vibration.vibrate([0, 750, 350], true);
    if (ringtoneRef.current) return;
    try {
      await setIsAudioActiveAsync(true);
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false
      });
      const player = createAudioPlayer(require("./assets/incoming-call.wav"), {
        keepAudioSessionActive: true
      });
      player.loop = true;
      player.volume = 0.85;
      player.play();
      ringtoneRef.current = player;
    } catch {
      // Vibration remains active if the platform refuses ringtone playback.
    }
  }

  async function stopIncomingCallTone(options: { deactivateAudio?: boolean } = {}) {
    Vibration.cancel();
    const player = ringtoneRef.current;
    ringtoneRef.current = null;
    if (player) {
      try {
        player.pause();
        player.remove();
      } catch {
        // The player may already be released during reloads or navigation.
      }
    }
    if (options.deactivateAudio !== false) {
      await resetAudioSession();
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
      await room.switchActiveDevice("videoinput", nextDevice.deviceId);
      setCameraDeviceID(nextDevice.deviceId);
      syncVideoTracks(room);
    } catch {
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

  if (!session) {
    return (
      <SafeAreaView style={styles.shell}>
        <ExpoStatusBar style="light" />
        <View style={styles.loginHero}>
          <View style={styles.logoMark}>
            <Image source={require("./assets/icon.png")} style={styles.logoImage} />
          </View>
          <Text style={styles.title}>Phone LevelG</Text>
          <Text style={styles.subtitle}>Private calls and messages for your home network.</Text>
        </View>
        <View style={styles.loginPanel}>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Name"
            placeholderTextColor="#7c8794"
            autoCapitalize="words"
            style={styles.input}
          />
          <TextInput
            value={inviteCode}
            onChangeText={setInviteCode}
            placeholder="Invite code"
            placeholderTextColor="#7c8794"
            autoCapitalize="none"
            returnKeyType="go"
            onSubmitEditing={login}
            secureTextEntry
            style={styles.input}
          />
          <Pressable style={styles.primaryButton} onPress={login}>
            <Text style={styles.primaryButtonText}>Join</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.shell}>
      <ExpoStatusBar style="light" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.chatLayout}
      >
        <View style={styles.header}>
          <View style={styles.identity}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>LG</Text>
              <View style={[styles.presence, connected ? styles.online : styles.offline]} />
            </View>
            <View>
              <Text style={styles.roomTitle}>{activeRoomTitle}</Text>
              <Text style={styles.status}>{connected ? callStatus : "Offline"}</Text>
            </View>
          </View>
          <View style={styles.headerActions}>
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

        {callActive && callMode === "video" && (
          <View style={styles.videoCallStage}>
            <View style={styles.remoteVideoFrame}>
              {displayedVideoTrack ? (
                <CameraStreamView key={displayedVideoTrack.sid} track={displayedVideoTrack} mirror={!remoteVideoTrack} zOrder={0} />
              ) : (
                <View style={styles.videoPlaceholder}>
                  <Video color="#c4b5fd" size={32} />
                  <Text style={styles.videoPlaceholderTitle}>Starting camera</Text>
                  <Text style={styles.videoPlaceholderText}>Camera preview will appear here.</Text>
                </View>
              )}
            </View>
            {remoteVideoTrack && localVideoTrack && (
              <View style={styles.localVideoFrame}>
                <CameraStreamView key={localVideoTrack.sid} track={localVideoTrack} mirror zOrder={1} />
              </View>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Switch camera"
              hitSlop={12}
              style={styles.flipCameraButton}
              onPress={() => void flipCamera()}
            >
              <SwitchCamera color="#ffffff" size={20} />
            </Pressable>
          </View>
        )}

        {callActive && (
          <View style={styles.callBanner}>
            <View>
              <Text style={styles.callTitle}>{callMode === "video" ? "Encrypted video call" : "Encrypted voice call"}</Text>
              <Text style={styles.callMeta}>{callParticipantLabel(callMode, remoteParticipantCount)}</Text>
            </View>
            <Pressable style={styles.hangupButton} onPress={leaveCall}>
              <PhoneOff color="#ffffff" size={18} />
            </Pressable>
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
                    <Text style={styles.memberAvatarText}>{initials(item.displayName)}</Text>
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
            <Pressable style={styles.homeRoomButton} onPress={() => setSelectedMember(null)}>
              <Text style={styles.homeRoomText}>Back to Home room</Text>
            </Pressable>
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
    </SafeAreaView>
  );
}

function CameraStreamView({ track, mirror, zOrder }: { track: LiveKitVideoTrack; mirror?: boolean; zOrder?: number }) {
  const [streamURL, setStreamURL] = useState("");

  useEffect(() => {
    const mediaStream = track.mediaStream as unknown as { toURL?: () => string } | undefined;
    setStreamURL(mediaStream?.toURL?.() ?? "");
  }, [track]);

  if (!streamURL) {
    return (
      <View style={styles.localVideoFallback}>
        <Video color="#ffffff" size={20} />
      </View>
    );
  }

  return (
    <RTCView
      streamURL={streamURL}
      style={styles.videoView}
      objectFit="cover"
      mirror={mirror}
      zOrder={zOrder}
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
    paddingTop: 64 + ANDROID_STATUS_BAR_HEIGHT,
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
  header: {
    minHeight: 76 + ANDROID_STATUS_BAR_HEIGHT,
    paddingHorizontal: 16,
    paddingTop: 10 + ANDROID_STATUS_BAR_HEIGHT,
    paddingBottom: 10,
    backgroundColor: "#0f1720",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  identity: {
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
    color: "#f8fafc"
  },
  status: {
    fontSize: 13,
    color: "#b7c1cc",
    marginTop: 2
  },
  headerActions: {
    flexDirection: "row",
    gap: 8
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3c245f"
  },
  incomingCallOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 10,
    paddingHorizontal: 28,
    paddingTop: 78 + ANDROID_STATUS_BAR_HEIGHT,
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
  homeRoomButton: {
    alignSelf: "flex-start",
    minHeight: 34,
    marginTop: 8,
    marginHorizontal: 14,
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
