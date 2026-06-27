type Props = { active: boolean };

export function Card({ active }: Props) {
  return <section>{active ? <span>yes</span> : null}</section>;
}
