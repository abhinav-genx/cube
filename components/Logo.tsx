import Svg, { G, Path, Polygon } from 'react-native-svg';
import { FACES, LEAF_D } from './logoPaths';

type Props = { size?: number };

/**
 * Three faces, three tonal pairs: light top with a deep leaf, mid left with a pale leaf,
 * deep right with a light leaf. The same leaf path is mapped onto each face with a matrix,
 * so the leaves sit *on* the cube rather than floating in front of it.
 */
export function Logo({ size = 120 }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" accessibilityLabel="Cube">
      {Object.values(FACES).map((f) => (
        <Polygon key={f.points} points={f.points} fill={f.face} />
      ))}
      {Object.values(FACES).map((f) => (
        <G key={`${f.points}-leaf`} transform={`matrix(${f.matrix.join(' ')})`}>
          <Path d={LEAF_D} fill={f.leaf} />
        </G>
      ))}
    </Svg>
  );
}
