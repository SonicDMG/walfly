/**
 * /recording-chat?recordingId=<id> — Per-recording chat screen
 *
 * Pushed from the Recording Detail "Chat about this recording" button. It lives
 * outside the (tabs) group deliberately: a file named `chat.tsx` at the app root
 * would resolve to the same "/chat" URL as the Chat tab, and expo-router would
 * then have two routes competing for one path.
 */
import { useLocalSearchParams } from 'expo-router';
import ChatScreen from '../components/ChatScreen';

export default function RecordingChatScreen() {
  const { recordingId } = useLocalSearchParams<{ recordingId: string }>();
  return <ChatScreen recordingId={recordingId} title="Chat about this recording" />;
}
