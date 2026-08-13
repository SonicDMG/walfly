import { View, Text, StyleSheet } from 'react-native';

export default function RecordScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Record</Text>
      <Text style={styles.subtitle}>Tap to start recording</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
});
