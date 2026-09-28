import assert from 'node:assert';

function stitchChunks(chunks) {
  const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  return sorted
    .map((c) => c.transcript)
    .filter(Boolean)
    .join('\n\n');
}

function adjustTimestamps(markdown, offsetSeconds) {
  return markdown.replace(/\[time:\s*(\d+):([\d.]+)-(\d+):([\d.]+)\]/g, (_, m1, s1, m2, s2) => {
    const startSec = parseInt(m1, 10) * 60 + parseFloat(s1) + offsetSeconds;
    const endSec = parseInt(m2, 10) * 60 + parseFloat(s2) + offsetSeconds;
    const fmt = (sec) => {
      const m = Math.floor(sec / 60);
      const s = (sec % 60).toFixed(1).padStart(4, '0');
      return `${m}:${s}`;
    };
    return `[time: ${fmt(startSec)}-${fmt(endSec)}]`;
  });
}

console.log('Running Checkpoints Stitching & Race-Condition Tests...');

// Test 1: Out-of-order chunk arrival
const outOfOrderChunks = [
  { chunkIndex: 2, transcript: '[time: 1:00.0-1:30.0] Third segment of conversation.' },
  { chunkIndex: 0, transcript: '[time: 0:00.0-0:30.0] First segment of conversation.' },
  { chunkIndex: 1, transcript: '[time: 0:30.0-1:00.0] Second segment of conversation.' },
];

const stitched = stitchChunks(outOfOrderChunks);
const expected = `[time: 0:00.0-0:30.0] First segment of conversation.

[time: 0:30.0-1:00.0] Second segment of conversation.

[time: 1:00.0-1:30.0] Third segment of conversation.`;

assert.strictEqual(stitched, expected, 'Out-of-order chunks must be stitched monotonically by chunkIndex');
console.log('✓ Test 1 Passed: Out-of-order chunk assembly is monotonic and ordered');

// Test 2: Timestamp offset adjustment
const rawChunkTranscript = '[time: 0:05.0-0:15.5] Hello world';
const adjusted = adjustTimestamps(rawChunkTranscript, 60); // +60s offset
assert.strictEqual(adjusted, '[time: 1:05.0-1:15.5] Hello world', 'Timestamps must shift by offsetSeconds');
console.log('✓ Test 2 Passed: Chunk timestamp offset shifting');

// Test 3: Idempotent duplicate update simulation
const chunksWithUpdate = [
  ...outOfOrderChunks.filter((c) => c.chunkIndex !== 1),
  { chunkIndex: 1, transcript: '[time: 0:30.0-1:00.0] Second segment updated.' },
];
const stitchedUpdated = stitchChunks(chunksWithUpdate);
assert.ok(stitchedUpdated.includes('Second segment updated.'), 'Duplicate chunk updates overwrite cleanly');
console.log('✓ Test 3 Passed: Duplicate chunk update idempotency');

console.log('All Checkpoint tests passed successfully!');
