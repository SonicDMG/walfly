/**
 * TagEditor — inline add/remove tags on a recording.
 *
 * Controlled component: receives `tags` and calls `onChange` with the updated
 * array. The parent owns state and any persistence calls.
 *
 * Constraints (enforced silently, no error messages):
 *   - Max 32 tags — `+ Add tag` is hidden when the limit is reached
 *   - Max 64 chars per tag — enforced via TextInput maxLength
 *   - No duplicates — duplicate submissions are ignored (case-insensitive)
 */

import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { colors, fonts, fontSizes, spacing, radius } from '../lib/theme';

const MAX_TAGS = 32;
const MAX_TAG_CHARS = 64;

interface TagEditorProps {
  tags: string[];
  onChange: (tags: string[]) => void;
}

export function TagEditor({ tags, onChange }: TagEditorProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [inputValue, setInputValue] = useState('');

  function handleRemove(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  function handleAdd() {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setInputValue('');
      setIsAdding(false);
      return;
    }
    const isDuplicate = tags.some((t) => t.toLowerCase() === trimmed.toLowerCase());
    if (!isDuplicate) {
      onChange([...tags, trimmed]);
    }
    setInputValue('');
    setIsAdding(false);
  }

  return (
    <View style={styles.container}>
      {/* Chip row */}
      <View style={styles.chipRow}>
        {tags.map((tag) => (
          <View key={tag} style={styles.chip}>
            <Text style={styles.chipText}>{tag.toLowerCase()}</Text>
            <Pressable
              onPress={() => handleRemove(tag)}
              hitSlop={8}
              accessibilityLabel={`Remove tag ${tag}`}
              accessibilityRole="button"
            >
              <Text style={styles.removeButton}>×</Text>
            </Pressable>
          </View>
        ))}
      </View>

      {/* Input row — shown when isAdding */}
      {isAdding && (
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={inputValue}
            onChangeText={setInputValue}
            onSubmitEditing={handleAdd}
            autoFocus
            maxLength={MAX_TAG_CHARS}
            returnKeyType="done"
            placeholder="new tag"
            placeholderTextColor={colors.fog}
            selectionColor={colors.amber}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            onPress={handleAdd}
            hitSlop={8}
            accessibilityLabel="Add tag"
            accessibilityRole="button"
          >
            <Text style={styles.addButton}>+</Text>
          </Pressable>
        </View>
      )}

      {/* + Add tag pressable — hidden at max tags or while input is open */}
      {!isAdding && tags.length < MAX_TAGS && (
        <Pressable
          onPress={() => setIsAdding(true)}
          accessibilityLabel="Add tag"
          accessibilityRole="button"
        >
          <Text style={styles.addTagLabel}>+ add tag</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.amberSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.amberGlow,
    gap: 4,
  },
  chipText: {
    fontFamily: fonts.bodyMed,
    fontSize: fontSizes.xs,
    color: colors.amber,
  },
  removeButton: {
    fontFamily: fonts.body,
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.amber,
    lineHeight: fontSizes.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.charcoal,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  input: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: fontSizes.sm,
    color: colors.cream,
  },
  addButton: {
    fontFamily: fonts.body,
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.amber,
    lineHeight: fontSizes.md,
  },
  addTagLabel: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.fog,
    marginTop: 2,
  },
});
