import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme, type Theme } from '@/lib/theme';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color?: string }) {
  const t = useTheme();
  return <MaterialCommunityIcons name={name} size={size} color={color ?? t.text} />;
}

export const shadow = (t: Theme): ViewStyle =>
  Platform.select({
    web: { boxShadow: `0 6px 24px ${t.shadow}` } as ViewStyle,
    default: { shadowColor: '#000', shadowOpacity: t.dark ? 0.45 : 0.16, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  }) ?? {};

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ backgroundColor: t.surface, borderRadius: 20, padding: 16 }, shadow(t), style]}>{children}</View>;
}

export function T({
  children,
  variant = 'body',
  color,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  variant?: 'display' | 'title' | 'body' | 'caption' | 'label';
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const t = useTheme();
  const v = VARIANTS[variant];
  return (
    <Text numberOfLines={numberOfLines} style={[v, { color: color ?? (variant === 'caption' ? t.textMuted : t.text) }, style]}>
      {children}
    </Text>
  );
}

const VARIANTS: Record<string, TextStyle> = {
  display: { fontSize: 30, fontWeight: '800', letterSpacing: -0.6 },
  title: { fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  body: { fontSize: 15, fontWeight: '500' },
  caption: { fontSize: 13, fontWeight: '500' },
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
};

export function Button({
  label,
  onPress,
  icon,
  kind = 'primary',
  loading,
  disabled,
  style,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  /** Quando o rótulo visível não basta fora de contexto (ex.: "Confirmar" numa lista de alertas). */
  accessibilityLabel?: string;
  kind?: 'primary' | 'secondary' | 'danger' | 'learn';
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const bg = { primary: t.primary, secondary: t.surfaceAlt, danger: t.danger, learn: t.learn }[kind];
  const fg = kind === 'secondary' ? t.text : '#FFFFFF';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} color={fg} size={20} /> : null}
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  label,
  active,
  size = 48,
  color,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  active?: boolean;
  size?: number;
  color?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' },
        { backgroundColor: active ? t.primary : t.surface, opacity: pressed ? 0.8 : 1 },
        shadow(t),
      ]}
    >
      <Icon name={icon} color={active ? '#FFFFFF' : (color ?? t.text)} size={size * 0.48} />
    </Pressable>
  );
}

export function Chip({ label, tone = 'neutral', icon, onPress, selected }: {
  label: string;
  tone?: 'neutral' | 'learn' | 'success' | 'warning' | 'danger' | 'primary';
  icon?: IconName;
  onPress?: () => void;
  selected?: boolean;
}) {
  const t = useTheme();
  const colors = {
    neutral: [t.surfaceAlt, t.textMuted],
    learn: [t.learnSoft, t.learn],
    success: [t.dark ? '#0F2E25' : '#E7F7F0', t.success],
    warning: [t.dark ? '#33270C' : '#FDF3E1', t.warning],
    danger: [t.dark ? '#3A1717' : '#FDECEC', t.danger],
    primary: [t.dark ? '#14234A' : '#E8EFFF', t.primary],
  }[tone];
  const content = (
    <View style={[styles.chip, { backgroundColor: selected ? t.primary : colors[0] }]}>
      {icon ? <Icon name={icon} size={14} color={selected ? '#FFF' : colors[1]} /> : null}
      <Text style={[styles.chipText, { color: selected ? '#FFF' : colors[1] }]}>{label}</Text>
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

const styles = StyleSheet.create({
  button: { height: 52, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  chipText: { fontSize: 12, fontWeight: '700' },
});
