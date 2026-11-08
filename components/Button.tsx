import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { colors, radius, type } from '../lib/theme';

type Props = {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'quiet' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
  icon?: ReactNode;
};

export function Button({ title, onPress, variant = 'primary', disabled, busy, style, icon }: Props) {
  const off = disabled || busy;
  const primary = variant === 'primary';
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.base,
        primary && styles.primary,
        primary && pressed && styles.primaryPressed,
        !primary && pressed && styles.quietPressed,
        off && primary && styles.primaryOff,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? colors.frost : colors.leaf} />
      ) : (
        <>
          {icon}
          <Text
            style={[
              styles.label,
              primary && styles.labelPrimary,
              variant === 'danger' && styles.labelDanger,
              off && !primary && styles.labelOff,
            ]}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    paddingHorizontal: 20,
    borderRadius: radius.key,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  primary: { backgroundColor: colors.leaf },
  primaryPressed: { backgroundColor: colors.pine },
  primaryOff: { backgroundColor: colors.sage },
  quietPressed: { backgroundColor: colors.mist },
  label: { ...type.bodyMedium, color: colors.leaf },
  labelPrimary: { color: colors.frost },
  labelDanger: { color: colors.resin },
  labelOff: { color: colors.sage },
});
