/**
 * /chat?recordingId=<id> — Per-recording chat screen
 * Launched from the Recording Detail "Chat about this recording" button.
 */
import { useLocalSearchParams } from 'expo-router';
import ChatScreen from '../components/ChatScreen';

export default function RecordingChatScreen() {
  const { recordingId } = useLocalSearchParams<{ recordingId: string }>();
  return <ChatScreen recordingId={recordingId} title="Chat about this recording" />;
}
