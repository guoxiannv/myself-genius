import { Platform, StyleSheet } from 'react-native';

export const palette = {
  ink: '#241B3A', muted: '#756B8A', canvas: '#F8F7FC', surface: '#FFFFFF',
  border: '#E9E5F1', accent: '#6E4DE6', accentSoft: '#EEEAFE', success: '#1F9D72',
  warning: '#C58A19', danger: '#C85168',
};

export const layout = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.canvas },
  content: { flex: 1, width: '100%', maxWidth: 1180, alignSelf: 'center' },
  pagePadding: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 32 },
  title: { color: palette.ink, fontSize: 30, fontWeight: '800', letterSpacing: -0.6 },
  subtitle: { color: palette.muted, fontSize: 15, lineHeight: 22, marginTop: 8 },
  caption: { color: palette.muted, fontSize: 13, lineHeight: 18 },
  card: { backgroundColor: palette.surface, borderColor: palette.border, borderRadius: 20, borderWidth: 1, padding: 18 },
  shadow: Platform.select({ ios: { shadowColor: '#33205E', shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }, default: { elevation: 2 } }),
});
