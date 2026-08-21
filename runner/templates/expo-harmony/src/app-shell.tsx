import React, { useCallback, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';

import { CheckIcon, HomeIcon, PlusIcon, SettingsIcon } from './components/icons';
import { PrimaryButton, SectionLabel, Surface } from './components/ui';
import { layout, palette } from './theme';
import type { TemplateItem, TemplateTab } from './types';

const TABS: Array<{ id: TemplateTab; label: string; icon: typeof HomeIcon }> = [
  { id: 'home', label: '首页', icon: HomeIcon }, { id: 'activity', label: '动态', icon: CheckIcon }, { id: 'settings', label: '设置', icon: SettingsIcon },
];
const STARTER_ITEMS: TemplateItem[] = [{ id: 'one', title: '从这里开始', detail: '用产品核心任务替换模板内容。' }];

export function AppShell() {
  const { width: windowWidth } = useWindowDimensions();
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [tab, setTab] = useState<TemplateTab>('home');
  const [items, setItems] = useState(STARTER_ITEMS);
  const width = layoutWidth || windowWidth;
  const layoutReady = layoutWidth > 0;
  const onRootLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0) setLayoutWidth((current) => current === next ? current : next);
  }, []);
  const isDesktop = width >= 1280; const isTablet = width >= 640 && width < 1280;
  const navigation = <View style={[styles.nav, isDesktop && styles.desktopNav, isTablet && !isDesktop && styles.tabletNav]} testID="responsive-navigation">
    <View style={styles.brandRow}><HomeIcon color={palette.accent} /><Text style={styles.brand}>__APP_NAME__</Text></View>
    <View style={[styles.tabList, isDesktop && styles.desktopTabList]}>{TABS.map((entry) => { const Icon = entry.icon; return <Pressable accessibilityLabel={entry.label} accessibilityRole="tab" accessibilityState={{ selected: tab === entry.id }} key={entry.id} onPress={() => setTab(entry.id)} style={[styles.tab, tab === entry.id && styles.activeTab]} testID={`tab-${entry.id}`}><Icon color={tab === entry.id ? palette.accent : palette.muted} /><Text style={[styles.tabLabel, tab === entry.id && styles.activeTabLabel]}>{entry.label}</Text></Pressable>; })}</View>
  </View>;
  const content = <ScrollView contentContainerStyle={layout.pagePadding} style={layout.content}>
      <View style={styles.hero}><SectionLabel>Product starter</SectionLabel><Text style={layout.title}>把明确任务变成可验证的体验。</Text><Text style={layout.subtitle}>保留响应式壳，替换全部模板业务内容。</Text></View>
      <Surface style={styles.callout}><View style={styles.calloutCopy}><Text style={styles.calloutTitle}>核心状态闭环</Text><Text style={layout.caption} testID="item-count">当前 {items.length} 条</Text></View><PrimaryButton label="添加条目" onPress={() => setItems((current) => [...current, { id: String(Date.now()), title: '新的条目', detail: '状态已更新。' }])} testID="primary-action" /></Surface>
      <View style={[styles.list, isDesktop && styles.desktopList]}>{items.map((item) => <Surface key={item.id} style={isDesktop ? styles.desktopListCard : undefined}><View style={styles.itemRow}><CheckIcon color={palette.success} /><View style={styles.itemCopy}><Text style={styles.itemTitle}>{item.title}</Text><Text style={layout.caption}>{item.detail}</Text></View></View></Surface>)}</View>
      <View style={styles.footer}><PlusIcon color={palette.accent} /><Text style={layout.caption}>请删除全部模板文案和示例数据。</Text></View>
    </ScrollView>;
  const frame = <View style={[styles.frame, isDesktop && styles.desktopFrame]}>{isDesktop && navigation}<View style={styles.main}>{isTablet && navigation}{content}{!isDesktop && !isTablet && navigation}</View></View>;
  return <SafeAreaView onLayout={onRootLayout} style={layout.screen} testID="app-shell">
    {layoutReady ? frame : <View style={styles.frame} testID="layout-loading" />}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  frame: { flex: 1 }, desktopFrame: { flexDirection: 'row' }, main: { flex: 1, minWidth: 0 }, nav: { backgroundColor: palette.surface, borderColor: palette.border, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 12, paddingVertical: 10 },
  desktopNav: { borderRightWidth: 1, borderTopWidth: 0, flexDirection: 'column', justifyContent: 'flex-start', paddingHorizontal: 18, paddingTop: 30, width: 220 }, tabletNav: { borderBottomWidth: 1, borderTopWidth: 0, justifyContent: 'flex-start', paddingVertical: 14 },
  brandRow: { alignItems: 'center', flexDirection: 'row', gap: 10, marginBottom: 22 }, brand: { color: palette.ink, flexShrink: 1, fontSize: 16, fontWeight: '800' }, tabList: { flexDirection: 'row', gap: 6 }, desktopTabList: { flexDirection: 'column', width: '100%' },
  tab: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 44, paddingHorizontal: 12 }, activeTab: { backgroundColor: palette.accentSoft }, tabLabel: { color: palette.muted, fontSize: 13, fontWeight: '700' }, activeTabLabel: { color: palette.accent },
  hero: { marginBottom: 22, maxWidth: 720 }, callout: { alignItems: 'center', flexDirection: 'row', gap: 16, justifyContent: 'space-between', marginBottom: 18 }, calloutCopy: { flex: 1, gap: 6 }, calloutTitle: { color: palette.ink, fontSize: 17, fontWeight: '800' },
  list: { gap: 14 }, desktopList: { flexDirection: 'row', flexWrap: 'wrap' }, desktopListCard: { flexBasis: '48%', flexGrow: 0, maxWidth: '48%' }, itemRow: { alignItems: 'center', flexDirection: 'row', gap: 12 }, itemCopy: { flex: 1, gap: 5 }, itemTitle: { color: palette.ink, fontSize: 17, fontWeight: '800' }, footer: { alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center', marginTop: 24 },
});
