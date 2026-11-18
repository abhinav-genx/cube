import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors } from '../lib/theme';

type Props = { count: number; shakeKey: number; min?: number };

const MIN_DOTS = 6;

/** Shows how many digits are entered. `shakeKey` changing triggers one shake. */
export function PinDots({ count, shakeKey, min = MIN_DOTS }: Props) {
  const x = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (shakeKey === 0) return;
    x.setValue(0);
    Animated.sequence([
      Animated.timing(x, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(x, { toValue: -1, duration: 60, useNativeDriver: true }),
      Animated.timing(x, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(x, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  }, [shakeKey, x]);

  const dots = Math.max(min, count);
  const translateX = x.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] });

  return (
    <Animated.View style={[styles.row, { transform: [{ translateX }] }]}>
      {Array.from({ length: dots }, (_, i) => (
        <View key={i} style={[styles.dot, i < count && styles.dotOn]} />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center', gap: 14, height: 14 },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: colors.sage },
  dotOn: { backgroundColor: colors.leaf, borderColor: colors.leaf },
});
