import React, { type PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { layout, palette } from '../theme';

export function Surface({ children, style, testID }: PropsWithChildren<{ style?: object; testID?: string }>) {
  return <View style={[layout.card, layout.shadow, style]} testID={testID}>{children}</View>;
}

export function PrimaryButton({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return <Pressable accessibilityLabel={label} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.primary, pressed && styles.pressed]} testID={testID}><Text style={styles.primaryLabel}>{label}</Text></Pressable>;
}

export function SectionLabel({ children }: PropsWithChildren) { return <Text style={styles.sectionLabel}>{children}</Text>; }

const styles = StyleSheet.create({
  primary: { alignItems: 'center', backgroundColor: palette.accent, borderRadius: 14, minHeight: 48, justifyContent: 'center', paddingHorizontal: 18 },
  primaryLabel: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.76, transform: [{ scale: 0.98 }] },
  sectionLabel: { color: palette.muted, fontSize: 12, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase' },
});
